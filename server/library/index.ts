// Library: one index of everything created in the app (images/media, chats, evolve jobs, fossils,
// proven patterns, memories, AkashicRecord entries, canvas workflows/runs, buyer outputs).
// The index lives in agent.db (lib_items + lib_fts). Media stays in DATA_DIR/outputs; text items are
// snapshotted to DATA_DIR/library/<type>/<id>.json so they survive deletion of their source.
// Nothing here is auto-purged except items owned by anonymous visitors (follows the visitor retention rules).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, statfsSync, unlinkSync, writeFileSync, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { db, now } from '../agent/db'
import { appendRecord } from '../memory/record'
import { zipStream, type ZipEntry } from './zip'

const DATA = () => process.env.DATA_DIR || './data'
const abs = (rel: string) => `${DATA()}/${rel}`
export const LIB_TYPES = ['image', 'media', 'chat', 'evolve', 'fossil', 'pattern', 'memory', 'akashic', 'canvas', 'buyer'] as const
export type LibType = typeof LIB_TYPES[number]
const OWNER = 'local'
export const isOwner = (uid: string) => uid === OWNER || (process.env.OWNER_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(uid)

db.exec(`
create table if not exists lib_items(id text primary key, user_id text not null, type text not null, title text, agent_id text, tags text default '[]', favorite integer default 0,
  created_at integer, updated_at integer, source_id text not null, file_path text, mime text, preview text, size integer default 0, meta text, unique(type, source_id));
create index if not exists idx_lib_user on lib_items(user_id, created_at);
create index if not exists idx_lib_type on lib_items(type, created_at);
create table if not exists lib_tombstones(id text primary key, deleted_at integer);
create table if not exists lib_files(path text primary key, item_id text not null);
create table if not exists lib_kv(k text primary key, v text);
`)
try { db.exec(`create virtual table if not exists lib_fts using fts5(id unindexed, title, body, tags, tokenize='porter unicode61')`) } catch (e: any) { console.error('[library] fts unavailable:', e.message) }

const kv = { get: (k: string) => (db.prepare('select v from lib_kv where k=?').get(k) as any)?.v as string | undefined, set: (k: string, v: any) => db.prepare('insert into lib_kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v').run(k, String(v)) }
const itemId = (type: string, sourceId: string) => 'lib_' + createHash('sha256').update(`${type}:${sourceId}`).digest('hex').slice(0, 20)
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', json: 'application/json' }
const extOf = (p: string) => (p.split('.').pop() || '').toLowerCase()
const mediaType = (name: string): LibType => (/^image\//.test(MIME[extOf(name)] || '') ? 'image' : 'media')
const clip = (s: any, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const parse = (s: any, d: any = null) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const sqlTime = (s: any) => { const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')); return Number.isFinite(t) ? t : now() }
const sizeOf = (rel?: string | null) => { try { return rel ? statSync(abs(rel)).size : 0 } catch { return 0 } }
const OUT_RE = /\/outputs\/([\w-][\w.-]*\.(?:png|jpe?g|webp|gif|mp4|webm|wav|mp3|ogg))/g
const outputsIn = (s: any) => [...new Set([...String(s ?? '').matchAll(OUT_RE)].map((m) => m[1]))]

let quiet = false // during the first backfill, don't write one record entry per item
let added = 0

export type UpsertInput = {
  type: LibType; sourceId: string; userId: string; title: string; agentId?: string | null; createdAt?: number
  filePath?: string | null; mime?: string | null; preview?: string; body?: string; tags?: string[]; meta?: any
  snapshot?: { text: string; data: any }; onlyIfNew?: boolean
}

export function upsertItem(i: UpsertInput): string | null {
  const id = itemId(i.type, i.sourceId)
  if (db.prepare('select 1 from lib_tombstones where id=?').get(id)) return null
  const ex = db.prepare('select id,user_id,tags,meta from lib_items where id=?').get(id) as any
  if (ex && i.onlyIfNew) return id
  let filePath = i.filePath || null
  if (i.snapshot) {
    const rel = `library/${i.type}/${id}.json`
    mkdirSync(abs(`library/${i.type}`), { recursive: true })
    writeFileSync(abs(rel), JSON.stringify({ id, type: i.type, sourceId: i.sourceId, title: i.title, savedAt: new Date().toISOString(), text: i.snapshot.text, data: i.snapshot.data }, null, 2))
    if (!filePath) filePath = rel
  }
  const mime = i.mime || (filePath ? MIME[extOf(filePath)] || 'application/octet-stream' : null)
  const t = now()
  const autoTags = [...new Set((Array.isArray(i.tags) ? i.tags : []).filter(Boolean).map((x) => clip(x, 40)))]
  if (ex) {
    // keep user-added tags/favorite; merge auto tags; an orphan file item can be attributed later
    const tags = [...new Set([...parse(ex.tags, []), ...autoTags])]
    const meta = { ...parse(ex.meta, {}), ...(i.meta || {}) }
    if (i.userId !== ex.user_id && meta.orphan) delete meta.orphan
    db.prepare('update lib_items set user_id=?,title=?,agent_id=?,tags=?,updated_at=?,file_path=?,mime=?,preview=?,size=?,meta=? where id=?')
      .run(meta.orphan ? ex.user_id : i.userId, clip(i.title, 200), i.agentId ?? null, JSON.stringify(tags), t, filePath, mime, clip(i.preview ?? '', 400), sizeOf(filePath), JSON.stringify(meta), id)
  } else {
    db.prepare('insert into lib_items(id,user_id,type,title,agent_id,tags,favorite,created_at,updated_at,source_id,file_path,mime,preview,size,meta) values(?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)')
      .run(id, i.userId, i.type, clip(i.title, 200), i.agentId ?? null, JSON.stringify(autoTags), i.createdAt || t, t, i.sourceId, filePath, mime, clip(i.preview ?? '', 400), sizeOf(filePath), JSON.stringify(i.meta || {}))
    added++
    if (!quiet) appendRecord('library.add', { id, type: i.type, sourceId: i.sourceId }, { userId: i.userId, agentId: i.agentId || undefined })
  }
  try {
    const tags = (db.prepare('select tags from lib_items where id=?').get(id) as any).tags
    db.prepare('delete from lib_fts where id=?').run(id)
    db.prepare('insert into lib_fts(id,title,body,tags) values(?,?,?,?)').run(id, i.title, String(i.body ?? i.snapshot?.text ?? i.preview ?? '').slice(0, 200_000), parse(tags, []).join(' '))
  } catch {}
  return id
}

// A run/thread "covers" an output file: unattributed (orphan) duplicates are dropped
function cover(name: string, itemIdv: string) {
  const prev = db.prepare('select item_id from lib_files where path=?').get(name) as any
  if (prev?.item_id === itemIdv) return
  db.prepare('insert into lib_files(path,item_id) values(?,?) on conflict(path) do update set item_id=excluded.item_id').run(name, itemIdv)
  const orphan = db.prepare("select id from lib_items where type in ('image','media') and source_id=? and json_extract(meta,'$.orphan')=1").get(`file:${name}`) as any
  if (orphan && orphan.id !== itemIdv) removeRow(orphan.id)
}
function removeRow(id: string) {
  db.prepare('delete from lib_items where id=?').run(id)
  try { db.prepare('delete from lib_fts where id=?').run(id) } catch {}
}

/** Register an output file under its creator (used by the canvas endpoints and the outputs scan). */
export function addOutputFile(name: string, a: { userId: string; title: string; agentId?: string | null; tags?: string[]; meta?: any; createdAt?: number; onlyIfNew?: boolean }) {
  if (!existsSync(abs(`outputs/${name}`))) return null
  return upsertItem({ type: mediaType(name), sourceId: `file:${name}`, userId: a.userId, title: a.title, agentId: a.agentId, createdAt: a.createdAt,
    filePath: `outputs/${name}`, preview: a.title, body: [a.title, a.meta?.prompt].filter(Boolean).join('\n'), tags: a.tags, meta: a.meta, onlyIfNew: a.onlyIfNew })
}

// ---------- sources ----------
function syncThreads() {
  const wm = Number(kv.get('wm.threads') || 0)
  const rows = db.prepare('select * from threads where updated_at>? order by updated_at limit 500').all(wm) as any[]
  for (const t of rows) {
    const msgs = db.prepare('select role,content,tool_calls,tool_call_id,name,created_at from messages where thread_id=? order by id').all(t.id) as any[]
    const args: Record<string, any> = {}
    for (const m of msgs) for (const c of parse(m.tool_calls, []) || []) args[c.id] = { name: c.name, arguments: c.arguments }
    const lines: string[] = []
    for (const m of msgs) {
      if (m.role === 'tool') lines.push(`⚙ ${m.name || 'tool'}${outputsIn(m.content).map((f) => ` → /outputs/${f}`).join('')}`)
      else if (m.content) lines.push(`**${m.role === 'user' ? 'You' : t.agent_id}**: ${m.content}`)
      for (const c of parse(m.tool_calls, []) || []) lines.push(`→ ${c.name}(${clip(JSON.stringify(c.arguments), 300)})`)
    }
    const delegated = String(t.title || '').startsWith('[delegated]')
    const first = msgs.find((m) => m.role === 'user')?.content
    const cid = upsertItem({ type: 'chat', sourceId: `thread:${t.id}`, userId: t.user_id, agentId: t.agent_id, createdAt: t.created_at,
      title: t.title || clip(first, 80) || 'Chat', preview: clip(msgs.filter((m) => m.role === 'assistant' && m.content).pop()?.content || first, 300),
      tags: [t.agent_id, delegated ? 'delegated' : ''], meta: { threadId: t.id, messages: msgs.length },
      snapshot: { text: `# ${t.title || 'Chat'}\nAgent: ${t.agent_id}\n\n${lines.join('\n\n')}`, data: { thread: t, messages: msgs.map((m) => ({ ...m, tool_calls: parse(m.tool_calls, undefined) })) } } })
    for (const m of msgs) {
      const files = outputsIn(m.content)
      if (!files.length) continue
      const call = m.tool_call_id ? args[m.tool_call_id] : null
      const prompt = call?.arguments?.prompt || call?.arguments?.text || first
      for (const f of files) {
        const id = addOutputFile(f, { userId: t.user_id, agentId: t.agent_id, createdAt: m.created_at, title: clip(prompt || `${m.name || 'output'} from ${t.agent_id}`, 160),
          tags: [t.agent_id, m.name || call?.name || ''], meta: { threadId: t.id, tool: m.name || call?.name, prompt: prompt ? clip(prompt, 1000) : undefined, chatItem: cid } })
        if (id) db.prepare('insert into lib_files(path,item_id) values(?,?) on conflict(path) do nothing').run(f, id)
      }
    }
  }
  if (rows.length) kv.set('wm.threads', rows[rows.length - 1].updated_at)
  return rows.length
}

function syncVisitorChats() {
  if (!db.prepare("select 1 from sqlite_master where name='visitor_msgs'").get()) return 0
  const wm = Number(kv.get('wm.visitor_msgs') || 0)
  const max = (db.prepare('select max(id) m from visitor_msgs').get() as any)?.m || 0
  if (max <= wm) return 0
  const pairs = db.prepare('select distinct visitor_id,thread_id from visitor_msgs where id>?').all(wm) as any[]
  for (const p of pairs) {
    const msgs = db.prepare('select role,content,created_at from visitor_msgs where visitor_id=? and thread_id=? order by id').all(p.visitor_id, p.thread_id) as any[]
    if (!msgs.length) continue
    const first = msgs.find((m) => m.role === 'user')?.content || msgs[0].content
    upsertItem({ type: 'chat', sourceId: `visitor:${p.visitor_id}:${p.thread_id}`, userId: `visitor:${p.visitor_id}`, agentId: 'public_concierge', createdAt: msgs[0].created_at,
      title: clip(first, 80) || 'Visitor chat', preview: clip(msgs[msgs.length - 1].content, 300), tags: ['visitor'],
      meta: { threadId: p.thread_id, messages: msgs.length },
      snapshot: { text: msgs.map((m) => `**${m.role === 'user' ? 'Visitor' : 'Concierge'}**: ${m.content}`).join('\n\n'), data: { threadId: p.thread_id, messages: msgs } } })
  }
  kv.set('wm.visitor_msgs', max)
  return pairs.length
}

function syncById(table: string, key: string, fn: (r: any) => void) {
  if (!db.prepare('select 1 from sqlite_master where name=?').get(table)) return 0
  const wm = Number(kv.get(key) || 0)
  const rows = db.prepare(`select * from ${table} where id>? order by id limit 1000`).all(wm) as any[]
  for (const r of rows) fn(r)
  if (rows.length) kv.set(key, rows[rows.length - 1].id)
  return rows.length
}
function syncByUpdated(table: string, key: string, fn: (r: any) => void) {
  if (!db.prepare('select 1 from sqlite_master where name=?').get(table)) return 0
  const wm = Number(kv.get(key) || 0)
  const rows = db.prepare(`select * from ${table} where updated_at>? order by updated_at limit 1000`).all(wm) as any[]
  for (const r of rows) fn(r)
  if (rows.length) kv.set(key, rows[rows.length - 1].updated_at)
  return rows.length
}

function syncEvolve() {
  return syncByUpdated('evolve_jobs', 'wm.evolve', (j) => {
    const rounds = parse(j.rounds, []) || []
    const last = rounds[rounds.length - 1] || {}
    const code = last.files?.['solution.mjs'] || last.solution || ''
    upsertItem({ type: 'evolve', sourceId: j.id, userId: j.user_id, agentId: 'evolve', createdAt: j.created_at, title: `Evolve: ${clip(j.task, 120)}`,
      preview: `${j.status}${j.fossil_id ? ` · fossil ${j.fossil_id}` : ''}${j.error ? ` · ${clip(j.error, 160)}` : ''} · ${rounds.length} round(s)`,
      tags: [j.status], meta: { jobId: j.id, status: j.status, fossilId: j.fossil_id, rounds: rounds.length },
      body: `${j.task}\n${j.error || ''}\n${clip(code, 20000)}`,
      snapshot: { text: `# Evolve job ${j.id}\nStatus: ${j.status}\nTask: ${j.task}\n${j.fossil_id ? `Fossil: ${j.fossil_id}\n` : ''}${j.error ? `Error: ${j.error}\n` : ''}Rounds: ${rounds.length}${code ? `\n\n\`\`\`js\n${code}\n\`\`\`` : ''}`, data: { ...j, rounds } } })
  })
}

function syncFossils() {
  return syncById('kg_modules', 'wm.kg_modules', (m) => {
    if (!m.fossil_id) {
      upsertItem({ type: 'akashic', sourceId: `module:${m.id}`, userId: m.user_id, createdAt: m.created_at, title: `Module: ${m.name}`, preview: m.description, tags: ['module', m.language], meta: { kind: 'module' },
        snapshot: { text: `# Module ${m.name}\n${m.description || ''}\nTests: ${m.tests || ''}`, data: m } })
      return
    }
    const dir = abs(`fossils/${m.fossil_id}`)
    const files: Record<string, string> = {}
    for (const f of ['solution.mjs', 'test.mjs', 'meta.json']) try { files[f] = readFileSync(`${dir}/${f}`, 'utf8') } catch {}
    upsertItem({ type: 'fossil', sourceId: `${m.fossil_id}:${m.user_id}`, userId: m.user_id, agentId: 'evolve', createdAt: m.created_at, title: `Fossil: ${m.name}`,
      preview: clip(m.description, 300), tags: [m.language, 'verified'], meta: { fossilId: m.fossil_id, sha256: m.sha256, dir: `fossils/${m.fossil_id}` },
      body: `${m.name}\n${m.description}\n${clip(files['solution.mjs'], 20000)}`,
      snapshot: { text: `# Fossil ${m.fossil_id} — ${m.name}\n${m.description || ''}\n${m.tests || ''}\n\n## solution.mjs\n\`\`\`js\n${files['solution.mjs'] || ''}\n\`\`\`\n\n## test.mjs\n\`\`\`js\n${files['test.mjs'] || ''}\n\`\`\``, data: { module: m, files } } })
  })
}

function syncPatterns() {
  return syncById('proven_patterns', 'wm.proven_patterns', (p) =>
    upsertItem({ type: 'pattern', sourceId: `pattern:${p.id}`, userId: p.user_id, agentId: 'evolve', createdAt: p.created_at, title: `Pattern: ${p.name || p.fossil_id}`,
      preview: p.pattern, tags: ['proven'], meta: { fossilId: p.fossil_id }, snapshot: { text: `**${p.name}** (${p.fossil_id}): ${p.pattern}`, data: p } }))
}

function syncMemories() {
  let n = syncById('memories', 'wm.memories', (m) =>
    upsertItem({ type: 'memory', sourceId: `memories:${m.id}`, userId: m.user_id, agentId: m.agent_id, createdAt: m.created_at, title: clip(m.text, 100),
      preview: m.text, tags: parse(m.tags, String(m.tags || '').split(',')) || [], meta: { memoryId: m.id }, snapshot: { text: m.text, data: m } }))
  const skip = new Set(['user said', 'agent replied', 'visitor said', 'entity', 'decision', 'fossil'])
  n += syncById('mem_docs', 'wm.mem_docs', (d) => {
    if (skip.has(d.kind) || String(d.source || '').startsWith('memories:')) return
    const { embedding, ...data } = d
    upsertItem({ type: 'memory', sourceId: `doc:${d.id}`, userId: d.user_id, agentId: d.agent_id, createdAt: d.created_at, title: clip(d.text, 100),
      preview: d.text, tags: [d.kind, d.scope], meta: { docId: d.id, kind: d.kind }, snapshot: { text: d.text, data } })
  })
  return n
}

function syncAkashic() {
  let n = syncByUpdated('kg_entities', 'wm.kg_entities', (e) =>
    upsertItem({ type: 'akashic', sourceId: `entity:${e.user_id}:${e.name}`, userId: e.user_id, createdAt: e.created_at, title: `${e.name}${e.type ? ` (${e.type})` : ''}`,
      preview: e.summary, tags: ['entity', e.type], meta: { kind: 'entity' }, snapshot: { text: `**${e.name}**${e.type ? ` (${e.type})` : ''}: ${e.summary || ''}\n${e.props || ''}`, data: { ...e, props: parse(e.props, e.props) } } }))
  n += syncById('kg_relations', 'wm.kg_relations', (r) =>
    upsertItem({ type: 'akashic', sourceId: `relation:${r.id}`, userId: r.user_id, createdAt: r.created_at, title: `${r.src} —${r.rel}→ ${r.dst}`,
      preview: r.note, tags: ['relation', r.rel], meta: { kind: 'relation' }, snapshot: { text: `${r.src} ${r.rel} ${r.dst}${r.note ? ` — ${r.note}` : ''}`, data: r } }))
  n += syncById('kg_decisions', 'wm.kg_decisions', (d) =>
    upsertItem({ type: 'akashic', sourceId: `decision:${d.id}`, userId: d.user_id, agentId: d.agent_id, createdAt: d.created_at, title: `Decision: ${d.title}`,
      preview: d.decision, tags: ['decision', d.status], meta: { kind: 'decision', status: d.status },
      snapshot: { text: `# Decision: ${d.title}\n${d.decision}${d.rationale ? `\n\nWhy: ${d.rationale}` : ''}\nStatus: ${d.status}`, data: d } }))
  return n
}

// nodular.db (workflow store) — only when the local SQLite store is in use
let ndb: any = null
async function nodular() {
  if (ndb !== null) return ndb || null
  const p = abs('nodular.db')
  if (!existsSync(p)) return null
  try { const { DatabaseSync } = await import('node:sqlite'); ndb = new DatabaseSync(p) } catch { ndb = false }
  return ndb || null
}
async function syncWorkflows() {
  const n = await nodular(); if (!n) return 0
  let count = 0
  try {
    const wm = kv.get('wm.workflows') || ''
    const wfs = n.prepare('select * from workflows where updated_at>? order by updated_at limit 500').all(wm) as any[]
    for (const w of wfs) {
      const nodes = parse(w.nodes, []) || []
      upsertItem({ type: 'canvas', sourceId: `workflow:${w.id}`, userId: w.user_id, agentId: 'canvas', createdAt: sqlTime(w.created_at), title: `Workflow: ${w.name}`,
        preview: `${nodes.length} node(s)${w.is_deployed ? ` · deployed ${w.deploy_url || ''}` : ''} · ${w.runs || 0} run(s)`, tags: ['workflow', w.is_deployed ? 'deployed' : ''],
        meta: { workflowId: w.id }, snapshot: { text: `# Workflow ${w.name}\nNodes: ${nodes.map((x: any) => x.type || x.data?.label).join(', ')}`, data: { ...w, nodes, edges: parse(w.edges, []) } } })
      count++
    }
    if (wfs.length) kv.set('wm.workflows', wfs[wfs.length - 1].updated_at)
    const rwm = Number(kv.get('wm.workflow_runs') || 0)
    const runs = n.prepare('select * from workflow_runs where id>? order by id limit 1000').all(rwm) as any[]
    for (const r of runs) {
      const buyer = r.workflow_id === 'buyer-enhance'
      const results = parse(r.results, {}) || {}
      const files = [...new Set([...outputsIn(r.final_image_url), ...outputsIn(r.results)])]
      const final = outputsIn(r.final_image_url)[0]
      const filePath = final && existsSync(abs(`outputs/${final}`)) ? `outputs/${final}` : null
      const id = upsertItem({ type: buyer ? 'buyer' : 'canvas', sourceId: `run:${r.id}`, userId: r.user_id, agentId: buyer ? 'buyer-enhance' : 'canvas', createdAt: sqlTime(r.created_at),
        title: `${buyer ? 'Enhance' : 'Run'}: ${clip(r.input_prompt || r.workflow_id, 140)}`, preview: `${r.status} · ${Math.round((r.duration_ms || 0) / 100) / 10}s${final ? '' : ' · no image'}`,
        tags: [buyer ? 'buyer' : 'run', r.status], filePath, body: `${r.input_prompt || ''}\n${r.final_html || ''}`,
        meta: { runId: r.id, workflowId: r.workflow_id, status: r.status, files, finalImageUrl: r.final_image_url },
        snapshot: filePath ? undefined : { text: `# ${buyer ? 'Enhance' : 'Workflow'} run ${r.id}\nPrompt: ${r.input_prompt || ''}\nStatus: ${r.status}\n${r.final_image_url ? `Image: ${r.final_image_url}` : ''}`, data: { ...r, results } } })
      if (id) for (const f of files) cover(f, id)
      count++
    }
    if (runs.length) kv.set('wm.workflow_runs', runs[runs.length - 1].id)
  } catch (e: any) { console.error('[library] workflow sync:', e.message) }
  return count
}

// Unattributed files in /outputs (e.g. created before the library existed) go to the owner
let lastOrphanScan = 0
function syncOrphanFiles() {
  const dir = abs('outputs'); if (!existsSync(dir)) return 0
  if (now() - lastOrphanScan < 30_000) return 0
  lastOrphanScan = now()
  const old = now() - 5 * 60_000
  const known = new Set((db.prepare("select source_id s from lib_items where type in ('image','media')").all() as any[]).map((r) => r.s))
  const covered = new Set((db.prepare('select path from lib_files').all() as any[]).map((r) => r.path))
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!MIME[extOf(f)] || known.has(`file:${f}`) || covered.has(f)) continue
    let st; try { st = statSync(`${dir}/${f}`) } catch { continue }
    if (!st.isFile() || st.mtimeMs > old) continue
    if (addOutputFile(f, { userId: OWNER, title: f, tags: ['unattributed'], meta: { orphan: 1 }, createdAt: Math.round(st.mtimeMs), onlyIfNew: true })) n++
  }
  return n
}

function purgeGoneVisitors() {
  if (!db.prepare("select 1 from sqlite_master where name='visitors'").get()) return
  const users = db.prepare("select distinct user_id u from lib_items where user_id like 'visitor:%'").all() as any[]
  for (const { u } of users) if (!db.prepare('select 1 from visitors where id=?').get(u.slice(8))) purgeUser(u)
}

let syncing: Promise<any> | null = null
export async function syncLibrary() {
  if (syncing) return syncing
  syncing = (async () => {
    const first = !kv.get('backfilled')
    quiet = first; added = 0
    const counts: Record<string, number> = {}
    const steps: [string, () => number | Promise<number>][] = [['threads', syncThreads], ['visitorChats', syncVisitorChats], ['evolve', syncEvolve], ['fossils', syncFossils],
      ['patterns', syncPatterns], ['memories', syncMemories], ['akashic', syncAkashic], ['workflows', syncWorkflows], ['orphanFiles', syncOrphanFiles]]
    for (const [k, fn] of steps) { try { counts[k] = await fn() } catch (e: any) { console.error(`[library] sync ${k} failed:`, e.message) } }
    try { purgeGoneVisitors() } catch {}
    if (first) {
      kv.set('backfilled', now())
      appendRecord('library.backfill', { items: added, sources: counts })
      console.log(`[library] backfilled ${added} items`)
    }
    quiet = false
    return { added, counts }
  })().finally(() => { syncing = null })
  return syncing
}
// Incremental sync is cheap (watermarked queries), so list/search requests always see fresh items
const freshSync = async () => { await syncLibrary() }

// ---------- delete / purge ----------
function removeFiles(it: any) {
  const rels = [it.file_path, `library/thumbs/${it.id}.webp`]
  if (String(it.file_path || '').startsWith('library/')) rels.push(it.file_path)
  for (const rel of rels) {
    if (!rel) continue
    if (rel.startsWith('outputs/') && db.prepare('select 1 from lib_items where file_path=? and id<>?').get(rel, it.id)) continue
    try { unlinkSync(abs(rel)) } catch {}
  }
  db.prepare('delete from lib_files where item_id=?').run(it.id)
}
export function deleteItem(id: string, by: string) {
  const it = db.prepare('select * from lib_items where id=?').get(id) as any
  if (!it) return false
  removeFiles(it)
  removeRow(id)
  db.prepare('insert or replace into lib_tombstones(id,deleted_at) values(?,?)').run(id, now())
  appendRecord('library.delete', { id, type: it.type, sourceId: it.source_id, owner: it.user_id === by ? undefined : 'admin' }, { userId: by })
  return true
}
/** Remove every item of one user (visitor forget / retention purge). */
export function purgeUser(userId: string) {
  const items = db.prepare('select * from lib_items where user_id=?').all(userId) as any[]
  for (const it of items) { removeFiles(it); removeRow(it.id) }
  return items.length
}

// ---------- query ----------
type Filters = { q?: string; type?: string; agent?: string; from?: string; to?: string; favorite?: string; tag?: string; owner?: string; ids?: string }
function where(uid: string, f: Filters) {
  const w: string[] = []; const a: any[] = []
  if (!isOwner(uid)) { w.push('i.user_id=?'); a.push(uid) }
  else {
    const o = f.owner || 'all'
    if (o === 'mine') { const ids = [OWNER, ...(process.env.OWNER_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)]; w.push(`i.user_id in (${ids.map(() => '?').join(',')})`); a.push(...ids) }
    else if (o === 'buyers') w.push("i.user_id like 'buyer_%'")
    else if (o === 'visitors') w.push("i.user_id like 'visitor:%'")
    else if (o === 'users') w.push("i.user_id not like 'buyer_%' and i.user_id not like 'visitor:%' and i.user_id<>'local'")
  }
  const types = String(f.type || '').split(',').filter((t) => (LIB_TYPES as readonly string[]).includes(t))
  if (types.length) { w.push(`i.type in (${types.map(() => '?').join(',')})`); a.push(...types) }
  if (f.agent) { w.push('i.agent_id=?'); a.push(String(f.agent)) }
  const d = (s?: string, end = false) => { if (!s) return null; const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s.length <= 10 ? s + (end ? 'T23:59:59.999' : 'T00:00:00') : s); return Number.isFinite(t) ? t : null }
  const from = d(f.from), to = d(f.to, true)
  if (from != null) { w.push('i.created_at>=?'); a.push(from) }
  if (to != null) { w.push('i.created_at<=?'); a.push(to) }
  if (f.favorite === '1' || f.favorite === 'true') w.push('i.favorite=1')
  if (f.tag) { w.push("exists (select 1 from json_each(i.tags) where value=?)"); a.push(String(f.tag)) }
  if (f.ids) { const ids = String(f.ids).split(',').filter(Boolean).slice(0, 5000); if (ids.length) { w.push(`i.id in (${ids.map(() => '?').join(',')})`); a.push(...ids) } }
  const toks = (String(f.q || '').match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12)
  if (toks.length) { w.push('i.id in (select id from lib_fts where lib_fts match ?)'); a.push(toks.map((t) => `"${t}"*`).join(' ')) }
  return { sql: w.length ? `where ${w.join(' and ')}` : '', args: a }
}
const out = (r: any) => ({ id: r.id, type: r.type, title: r.title, agentId: r.agent_id, userId: r.user_id, owner: ownerKind(r.user_id), tags: parse(r.tags, []), favorite: !!r.favorite,
  createdAt: r.created_at, updatedAt: r.updated_at, sourceId: r.source_id, mime: r.mime, preview: r.preview, size: r.size, meta: parse(r.meta, {}),
  hasFile: !!r.file_path, isMedia: String(r.file_path || '').startsWith('outputs/'),
  fileUrl: `/api/library/items/${r.id}/file`, thumbUrl: /^image\//.test(r.mime || '') ? `/api/library/items/${r.id}/thumb` : null,
  mediaUrl: String(r.file_path || '').startsWith('outputs/') ? '/' + r.file_path : null })
const ownerKind = (u: string) => (u === OWNER ? 'owner' : u.startsWith('buyer_') ? 'buyer' : u.startsWith('visitor:') ? 'visitor' : 'user')

export function listItems(uid: string, f: Filters & { limit?: string; offset?: string; sort?: string }) {
  const { sql, args } = where(uid, f)
  const limit = Math.min(Math.max(Number(f.limit) || 60, 1), 500), offset = Math.max(Number(f.offset) || 0, 0)
  const order = f.sort === 'oldest' ? 'i.created_at asc' : f.sort === 'size' ? 'i.size desc' : f.sort === 'title' ? 'i.title collate nocase asc' : 'i.created_at desc'
  const items = (db.prepare(`select i.* from lib_items i ${sql} order by ${order} limit ? offset ?`).all(...args, limit, offset) as any[]).map(out)
  const total = (db.prepare(`select count(*) n from lib_items i ${sql}`).get(...args) as any).n
  const base = where(uid, { owner: f.owner })
  const types = Object.fromEntries((db.prepare(`select type k, count(*) n from lib_items i ${base.sql} group by type`).all(...base.args) as any[]).map((r) => [r.k, r.n]))
  const agents = Object.fromEntries((db.prepare(`select agent_id k, count(*) n from lib_items i ${base.sql} ${base.sql ? 'and' : 'where'} agent_id is not null group by agent_id order by n desc limit 50`).all(...base.args) as any[]).map((r) => [r.k, r.n]))
  return { items, total, limit, offset, facets: { types, agents } }
}
function getOwned(uid: string, id: string) {
  const r = db.prepare('select * from lib_items where id=?').get(id) as any
  if (!r || (!isOwner(uid) && r.user_id !== uid)) return null
  return r
}
function readSnapshot(r: any) {
  if (!String(r.file_path || '').startsWith('library/')) return null
  try { return JSON.parse(readFileSync(abs(r.file_path), 'utf8')) } catch { return null }
}

function exportPlan(uid: string, f: Filters) {
  const { sql, args } = where(uid, f)
  const rows = db.prepare(`select i.* from lib_items i ${sql} order by i.created_at`).all(...args) as any[]
  const entries: (ZipEntry & { size: number })[] = []
  const slug = (s: string) => clip(s, 50).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'
  let bytes = 0
  for (const r of rows) {
    const base = `${r.type}/${new Date(r.created_at).toISOString().slice(0, 10)}_${slug(r.title)}_${r.id.slice(4, 12)}`
    if (!r.file_path) continue
    const p = abs(r.file_path)
    let size = 0; try { size = statSync(p).size } catch { continue }
    if (String(r.file_path).startsWith('library/')) {
      const snap = readSnapshot(r)
      const md = Buffer.from(String(snap?.text ?? ''), 'utf8')
      entries.push({ name: `${base}.md`, data: md, mtime: r.created_at, size: md.length })
      entries.push({ name: `${base}.json`, path: p, mtime: r.created_at, size })
      bytes += md.length + size
    } else {
      entries.push({ name: `${base}.${extOf(r.file_path)}`, path: p, mtime: r.created_at, size })
      bytes += size
    }
  }
  const overhead = entries.reduce((s, e) => s + 92 + 2 * Buffer.byteLength(e.name), 22)
  return { rows, entries, bytes: bytes + overhead }
}
const exportCap = () => Math.min(Number(process.env.LIBRARY_EXPORT_MAX_MB || 2048), 3900) * 1024 * 1024

export function volumeStats() {
  let volume: any = null
  try { const s = statfsSync(DATA()); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; volume = { path: DATA(), totalBytes: total, freeBytes: free, usedBytes: total - free, usedPct: Math.round(((total - free) / total) * 1000) / 10 } } catch {}
  return volume
}

// ---------- routes ----------
export function initLibrary() {
  syncLibrary().catch((e) => console.error('[library] initial sync failed:', e.message))
  setInterval(() => syncLibrary().catch(() => {}), Number(process.env.LIBRARY_SYNC_MS || 60_000)).unref()
}

export function registerLibraryRoutes(app: FastifyInstance) {
  const uid = (req: any) => String(req.userId)

  app.get('/api/library', async (req) => { await freshSync(); return listItems(uid(req), req.query as any) })
  app.get('/api/library/stats', async (req) => {
    await freshSync()
    const { sql, args } = where(uid(req), { owner: isOwner(uid(req)) ? 'all' : undefined })
    const byType = db.prepare(`select type, count(*) n, coalesce(sum(size),0) bytes from lib_items i ${sql} group by type`).all(...args)
    const tot = db.prepare(`select count(*) n, coalesce(sum(size),0) bytes from lib_items i ${sql}`).get(...args) as any
    return { owner: isOwner(uid(req)), items: tot.n, bytes: tot.bytes, byType, volume: isOwner(uid(req)) ? volumeStats() : undefined, exportMaxBytes: exportCap() }
  })
  app.post('/api/library/sync', async () => syncLibrary())
  app.get('/api/library/items/:id', async (req, reply) => {
    const r = getOwned(uid(req), (req.params as any).id)
    if (!r) return reply.status(404).send({ error: 'Not found' })
    const snap = readSnapshot(r)
    return { ...out(r), content: snap ? String(snap.text ?? '').slice(0, 300_000) : null, data: snap?.data ?? null }
  })
  const sendFile = (r: any, download: boolean, reply: any) => {
    if (!r.file_path || !existsSync(abs(r.file_path))) return reply.status(404).send({ error: 'File missing' })
    const snapshot = String(r.file_path).startsWith('library/')
    const name = `${r.type}-${String(r.title || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-|-$/g, '') || r.id}.${extOf(r.file_path)}`
    reply.header('Content-Type', r.mime || 'application/octet-stream').header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff')
    if (download || snapshot) reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
    return reply.send(createReadStream(abs(r.file_path)))
  }
  app.get('/api/library/items/:id/file', async (req, reply) => {
    const r = getOwned(uid(req), (req.params as any).id)
    if (!r) return reply.status(404).send({ error: 'Not found' })
    return sendFile(r, !!(req.query as any).download, reply)
  })
  app.get('/api/library/items/:id/thumb', async (req, reply) => {
    const r = getOwned(uid(req), (req.params as any).id)
    if (!r || !/^image\//.test(r.mime || '') || !r.file_path || !existsSync(abs(r.file_path))) return reply.status(404).send({ error: 'No thumbnail' })
    const rel = `library/thumbs/${r.id}.webp`
    if (!existsSync(abs(rel))) {
      try {
        const sharp = (await import('sharp')).default
        mkdirSync(abs('library/thumbs'), { recursive: true })
        await sharp(abs(r.file_path), { animated: false }).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(abs(rel))
      } catch { return sendFile(r, false, reply) }
    }
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=86400').send(createReadStream(abs(rel)))
  })
  app.patch('/api/library/items/:id', async (req, reply) => {
    const r = getOwned(uid(req), (req.params as any).id)
    if (!r) return reply.status(404).send({ error: 'Not found' })
    const b: any = req.body || {}
    const set: Record<string, any> = {}
    if (b.favorite !== undefined) set.favorite = b.favorite ? 1 : 0
    if (Array.isArray(b.tags)) set.tags = JSON.stringify([...new Set(b.tags.map((t: any) => clip(t, 40)).filter(Boolean))].slice(0, 30))
    if (typeof b.title === 'string' && b.title.trim()) set.title = clip(b.title, 200)
    if (!Object.keys(set).length) return reply.status(400).send({ error: 'favorite, tags or title required' })
    db.prepare(`update lib_items set ${Object.keys(set).map((k) => `${k}=?`).join(',')}, updated_at=? where id=?`).run(...Object.values(set), now(), r.id)
    try {
      const n = db.prepare('select title,tags from lib_items where id=?').get(r.id) as any
      const body = (db.prepare('select body from lib_fts where id=?').get(r.id) as any)?.body || ''
      db.prepare('delete from lib_fts where id=?').run(r.id)
      db.prepare('insert into lib_fts(id,title,body,tags) values(?,?,?,?)').run(r.id, n.title, body, parse(n.tags, []).join(' '))
    } catch {}
    appendRecord('library.update', { id: r.id, fields: Object.keys(set) }, { userId: uid(req) })
    return out(db.prepare('select * from lib_items where id=?').get(r.id))
  })
  app.delete('/api/library/items/:id', async (req, reply) => {
    const r = getOwned(uid(req), (req.params as any).id)
    if (!r) return reply.status(404).send({ error: 'Not found' })
    deleteItem(r.id, uid(req))
    return { ok: true }
  })
  app.get('/api/library/export/estimate', async (req) => {
    await freshSync()
    const p = exportPlan(uid(req), req.query as any)
    return { items: p.rows.length, files: p.entries.length + 1, bytes: p.bytes, maxBytes: exportCap(), ok: p.bytes <= exportCap() && p.entries.length < 65000 }
  })
  app.get('/api/library/export', async (req, reply) => {
    await freshSync()
    const f = req.query as any
    const p = exportPlan(uid(req), f)
    if (p.bytes > exportCap() || p.entries.length >= 65000) return reply.status(413).send({ error: `Export is ${Math.round(p.bytes / 1048576)} MB; the limit is ${Math.round(exportCap() / 1048576)} MB. Narrow it with filters (type, date range).`, bytes: p.bytes })
    const manifest = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), filters: f, items: p.rows.map(out) }, null, 2))
    appendRecord('library.export', { items: p.rows.length, bytes: p.bytes, filters: Object.keys(f || {}) }, { userId: uid(req) })
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="fraymus-library-${stamp}.zip"`).header('X-Export-Bytes', String(p.bytes + manifest.length + 140))
    return reply.send(Readable.from(zipStream([{ name: 'manifest.json', data: manifest }, ...p.entries])))
  })
}

/** Buyer-facing: a buyer sees only their own outputs. */
export function registerBuyerLibrary(app: FastifyInstance, resolve: (req: any) => Promise<{ id: string } | null>) {
  app.get('/buyer/library', async (req, reply) => {
    const u = await resolve(req)
    if (!u) return reply.status(401).send({ error: 'Sign in' })
    await freshSync()
    const r = listItems(u.id, { ...(req.query as any), type: 'buyer' })
    return { total: r.total, items: r.items.map((i) => ({ id: i.id, title: i.title, createdAt: i.createdAt, status: i.meta?.status, imageUrl: i.mediaUrl, size: i.size })) }
  })
}
