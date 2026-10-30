// Semantic store in SQLite (DATA_DIR/agent.db): FTS5 keyword search always, plus vector search when an
// OpenAI-compatible /embeddings endpoint answers (EMBED_BASE_URL / EMBED_API_KEY / EMBED_MODEL; EMBED_BACKEND=off disables).
// Scopes: 'agent' entries are seen only by that agent; 'shared' entries are seen by every agent of the same user.
import { db, now } from '../agent/db'

db.exec(`
create table if not exists mem_docs(id integer primary key autoincrement, user_id text not null, scope text not null, agent_id text, thread_id text, kind text, text text not null, source text, embedding blob, created_at integer);
create index if not exists idx_memdocs_user on mem_docs(user_id, id);
create index if not exists idx_memdocs_thread on mem_docs(thread_id);
create unique index if not exists idx_memdocs_source on mem_docs(source) where source is not null;
create virtual table if not exists mem_fts using fts5(text, content='mem_docs', content_rowid='id', tokenize='porter unicode61');
create trigger if not exists mem_docs_ai after insert on mem_docs begin insert into mem_fts(rowid, text) values (new.id, new.text); end;
create trigger if not exists mem_docs_ad after delete on mem_docs begin insert into mem_fts(mem_fts, rowid, text) values('delete', old.id, old.text); end;
create table if not exists mem_kv(k text primary key, v text);
`)

const MAX_DOC = 2000
const STOP = new Set('the and for are but not you your with this that have has had was were what when where which who why how can could would should will just from into about they them then than there their our out all any its it\'s also been being does did doing done get got like make made more most much some such very what\'s tell know remember'.split(' '))

// ---- embeddings (optional, degrades to FTS only)
const embedCfg = () => ({
  backend: (process.env.EMBED_BACKEND || 'auto').toLowerCase(),
  base: (process.env.EMBED_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, ''),
  key: process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY || '',
  model: process.env.EMBED_MODEL || 'text-embedding-3-small'
})
let embedDownUntil = 0
let embedLastError = ''
let embedOk = false
export function embedStatus() {
  const c = embedCfg()
  const configured = c.backend !== 'off' && !!c.base && !!c.key
  return { backend: configured ? 'openai-compatible' : 'off', model: configured ? c.model : undefined, working: embedOk, lastError: embedLastError || undefined, keywordSearch: 'sqlite-fts5' }
}
async function embed(texts: string[]): Promise<Float32Array[] | null> {
  const c = embedCfg()
  if (c.backend === 'off' || !c.base || !c.key || Date.now() < embedDownUntil) return null
  try {
    const r = await fetch(`${c.base}/embeddings`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key, ...(process.env.OPENAI_USER_AGENT ? { 'User-Agent': process.env.OPENAI_USER_AGENT } : {}) },
      body: JSON.stringify({ model: c.model, input: texts.map((t) => t.slice(0, 6000)) })
    })
    if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text()).slice(0, 120)}`)
    const j: any = await r.json()
    const out = (j.data || []).sort((a: any, b: any) => a.index - b.index).map((d: any) => Float32Array.from(d.embedding))
    if (out.length !== texts.length || !out[0]?.length) throw new Error('embeddings: unexpected response shape')
    embedOk = true; embedLastError = ''
    return out
  } catch (e: any) {
    embedOk = false; embedLastError = String(e.message || e).slice(0, 200)
    embedDownUntil = Date.now() + 30 * 60_000 // back off; keyword search keeps working
    return null
  }
}
const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const fromBlob = (b: any): Float32Array => { const u = b instanceof Uint8Array ? b : Buffer.from(b); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) }
function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return 0
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? d / Math.sqrt(na * nb) : 0
}

// ---- write
export type DocInput = { userId: string; scope: 'agent' | 'shared'; agentId?: string; threadId?: string; kind: string; text: string; source?: string }
const pendingEmbeds: number[] = []
let embedTimer: NodeJS.Timeout | null = null
export function indexDoc(d: DocInput): number | null {
  const text = String(d.text || '').trim().slice(0, MAX_DOC)
  if (text.length < 3) return null
  try {
    const r = db.prepare('insert or ignore into mem_docs(user_id,scope,agent_id,thread_id,kind,text,source,created_at) values(?,?,?,?,?,?,?,?)')
      .run(d.userId, d.scope, d.agentId ?? null, d.threadId ?? null, d.kind, text, d.source ?? null, now())
    const id = Number(r.lastInsertRowid)
    if (!Number(r.changes)) return null
    pendingEmbeds.push(id)
    if (!embedTimer) embedTimer = setTimeout(flushEmbeds, 1500)
    return id
  } catch (e: any) { console.error('[memory] index failed:', e.message); return null }
}
async function flushEmbeds() {
  embedTimer = null
  while (pendingEmbeds.length) {
    const ids = pendingEmbeds.splice(0, 32)
    const rows = db.prepare(`select id,text from mem_docs where id in (${ids.map(() => '?').join(',')})`).all(...ids) as any[]
    if (!rows.length) continue
    const vecs = await embed(rows.map((r) => r.text))
    if (!vecs) { pendingEmbeds.length = 0; return } // embeddings unavailable; FTS still has them
    rows.forEach((r, i) => db.prepare('update mem_docs set embedding=? where id=?').run(toBlob(vecs[i]), r.id))
  }
}
export const deleteThreadDocs = (userId: string, threadId: string) => Number(db.prepare('delete from mem_docs where user_id=? and thread_id=?').run(userId, threadId).changes)
export const deleteDoc = (userId: string, id: number) => Number(db.prepare('delete from mem_docs where user_id=? and id=?').run(userId, id).changes) > 0

// ---- read
export type Hit = { id: number; text: string; kind: string; scope: string; agentId: string | null; threadId: string | null; createdAt: number; score: number; via: string[] }
const words = (q: string) => [...new Set((q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) || []).map((w) => w.replace(/[-_]+/g, ' ').trim()).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 16)

export async function retrieve(userId: string, agentId: string | null, query: string, opts: { limit?: number; excludeThreadId?: string } = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 6
  const scopeSql = agentId ? "and (d.scope='shared' or d.agent_id=?)" : ''
  const exSql = opts.excludeThreadId ? 'and (d.thread_id is null or d.thread_id<>?)' : ''
  const params = (extra: any[]) => [userId, ...(agentId ? [agentId] : []), ...(opts.excludeThreadId ? [opts.excludeThreadId] : []), ...extra]
  const ranked = new Map<number, { row: any; rrf: number; via: string[] }>()
  const add = (rows: any[], via: string) => rows.forEach((row, i) => {
    const cur = ranked.get(row.id) || { row, rrf: 0, via: [] }
    cur.rrf += 1 / (60 + i); cur.via.push(via); ranked.set(row.id, cur)
  })
  const w = words(query)
  if (w.length) {
    const match = w.map((x) => `"${x.replace(/"/g, '')}"`).join(' OR ')
    try {
      add(db.prepare(`select d.id,d.text,d.kind,d.scope,d.agent_id,d.thread_id,d.created_at from mem_fts f join mem_docs d on d.id=f.rowid
        where mem_fts match ? and d.user_id=? ${scopeSql} ${exSql} order by bm25(mem_fts) limit ?`).all(match, ...params([limit * 3])) as any[], 'fts')
    } catch (e: any) { console.error('[memory] fts query failed:', e.message) }
  }
  if (query.trim()) {
    const qv = await embed([query])
    if (qv) {
      const rows = db.prepare(`select d.id,d.text,d.kind,d.scope,d.agent_id,d.thread_id,d.created_at,d.embedding from mem_docs d
        where d.user_id=? ${scopeSql} ${exSql} and d.embedding is not null order by d.id desc limit 3000`).all(...params([])) as any[]
      const scored = rows.map((r) => ({ r, s: cosine(qv[0], fromBlob(r.embedding)) })).filter((x) => x.s > 0.3).sort((a, b) => b.s - a.s).slice(0, limit * 3)
      add(scored.map((x) => { const { embedding, ...rest } = x.r; return rest }), 'vector')
    }
  }
  return [...ranked.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit).map(({ row, rrf, via }) => ({
    id: row.id, text: row.text, kind: row.kind, scope: row.scope, agentId: row.agent_id, threadId: row.thread_id, createdAt: row.created_at, score: Number(rrf.toFixed(4)), via
  }))
}

// Bounded block for the system prompt
export function formatHits(hits: Hit[], maxChars = 2400): string {
  let out = ''
  for (const h of hits) {
    const day = new Date(h.createdAt).toISOString().slice(0, 10)
    const line = `- [${day} ${h.kind}${h.scope === 'shared' ? ', shared' : ''}] ${h.text.replace(/\s+/g, ' ').slice(0, 500)}\n`
    if (out.length + line.length > maxChars) break
    out += line
  }
  return out.trim()
}

// One-time backfill so existing memories and past conversations become searchable
export function backfill() {
  if ((db.prepare("select v from mem_kv where k='backfill_v1'").get() as any)?.v) return
  let n = 0
  for (const m of db.prepare('select id,user_id,agent_id,text from memories order by id').all() as any[]) if (indexDoc({ userId: m.user_id, scope: 'shared', agentId: m.agent_id, kind: 'memory', text: m.text, source: `memories:${m.id}` })) n++
  const msgs = db.prepare(`select m.id,m.thread_id,m.role,m.content,t.user_id,t.agent_id,t.title from messages m join threads t on t.id=m.thread_id
    where m.role in ('user','assistant') and m.content is not null and length(m.content)>2 and t.title not like '[delegated]%' order by m.id desc limit 5000`).all() as any[]
  for (const m of msgs) if (indexDoc({ userId: m.user_id, scope: 'agent', agentId: m.agent_id, threadId: m.thread_id, kind: m.role === 'user' ? 'user said' : 'agent replied', text: m.content, source: `msg:${m.id}` })) n++
  db.prepare("insert into mem_kv(k,v) values('backfill_v1',?) on conflict(k) do update set v=excluded.v").run(String(Date.now()))
  if (n) console.log(`[memory] backfilled ${n} entries into the semantic store`)
}
