// AkashicRecord: a small knowledge graph in SQLite (entities, relations, decisions, verified modules) per user.
// Agents read/write it through tools; a compact current-state summary is injected into every agent prompt.
import { db, now } from '../agent/db'
import { appendRecord } from './record'
import { indexDoc } from './semantic'

db.exec(`
create table if not exists kg_entities(id integer primary key autoincrement, user_id text not null, name text not null, type text, summary text, props text, created_at integer, updated_at integer, unique(user_id, name));
create table if not exists kg_relations(id integer primary key autoincrement, user_id text not null, src text not null, rel text not null, dst text not null, note text, created_at integer, unique(user_id, src, rel, dst));
create table if not exists kg_decisions(id integer primary key autoincrement, user_id text not null, title text not null, decision text not null, rationale text, status text default 'active', agent_id text, created_at integer);
create table if not exists kg_modules(id integer primary key autoincrement, user_id text not null, name text not null, language text, fossil_id text, sha256 text, description text, tests text, created_at integer);
`)

const s = (v: any, n: number) => (v == null ? null : String(v).trim().slice(0, n))
const norm = (n: any) => s(n, 120)!.replace(/\s+/g, ' ')

export function upsertEntity(userId: string, a: { name: string; type?: string; summary?: string; props?: any }, agentId?: string) {
  const name = norm(a.name)
  if (!name) throw new Error('name required')
  const prev = db.prepare('select * from kg_entities where user_id=? and name=?').get(userId, name) as any
  const type = s(a.type, 60) ?? prev?.type ?? null
  const summary = s(a.summary, 1000) ?? prev?.summary ?? null
  const props = a.props && typeof a.props === 'object' ? JSON.stringify({ ...(prev?.props ? JSON.parse(prev.props) : {}), ...a.props }).slice(0, 4000) : prev?.props ?? null
  db.prepare(`insert into kg_entities(user_id,name,type,summary,props,created_at,updated_at) values(?,?,?,?,?,?,?)
    on conflict(user_id,name) do update set type=excluded.type, summary=excluded.summary, props=excluded.props, updated_at=excluded.updated_at`).run(userId, name, type, summary, props, now(), now())
  appendRecord('akashic.entity', { name, type, summary, props: props ? JSON.parse(props) : undefined, updated: !!prev }, { userId, agentId })
  const src = `entity:${userId}:${name}`
  db.prepare('delete from mem_docs where source=?').run(src)
  if (summary) indexDoc({ userId, scope: 'shared', agentId, kind: 'entity', text: `${name}${type ? ` (${type})` : ''}: ${summary}`, source: src })
  return { name, type, summary, updated: !!prev }
}

export function relate(userId: string, a: { src: string; rel: string; dst: string; note?: string }, agentId?: string) {
  const src = norm(a.src), dst = norm(a.dst), rel = s(a.rel, 60)
  if (!src || !dst || !rel) throw new Error('src, rel and dst required')
  for (const n of [src, dst]) db.prepare('insert or ignore into kg_entities(user_id,name,created_at,updated_at) values(?,?,?,?)').run(userId, n, now(), now())
  db.prepare('insert or ignore into kg_relations(user_id,src,rel,dst,note,created_at) values(?,?,?,?,?,?)').run(userId, src, rel, dst, s(a.note, 500), now())
  appendRecord('akashic.relation', { src, rel, dst, note: a.note }, { userId, agentId })
  return { src, rel, dst }
}

export function recordDecision(userId: string, a: { title: string; decision: string; rationale?: string; supersedes?: number }, agentId?: string) {
  const title = s(a.title, 200), decision = s(a.decision, 2000)
  if (!title || !decision) throw new Error('title and decision required')
  if (a.supersedes) db.prepare("update kg_decisions set status='superseded' where id=? and user_id=?").run(Number(a.supersedes), userId)
  const r = db.prepare('insert into kg_decisions(user_id,title,decision,rationale,agent_id,created_at) values(?,?,?,?,?,?)').run(userId, title, decision, s(a.rationale, 2000), agentId ?? null, now())
  const id = Number(r.lastInsertRowid)
  appendRecord('akashic.decision', { id, title, decision, rationale: a.rationale, supersedes: a.supersedes }, { userId, agentId })
  indexDoc({ userId, scope: 'shared', agentId, kind: 'decision', text: `Decision "${title}": ${decision}${a.rationale ? ` (why: ${a.rationale})` : ''}`, source: `decision:${id}` })
  return { id, title }
}

export function addModule(userId: string, m: { name: string; language: string; fossilId: string; sha256: string; description: string; tests: string }) {
  const r = db.prepare('insert into kg_modules(user_id,name,language,fossil_id,sha256,description,tests,created_at) values(?,?,?,?,?,?,?,?)').run(userId, s(m.name, 120), m.language, m.fossilId, m.sha256, s(m.description, 1000), s(m.tests, 500), now())
  return Number(r.lastInsertRowid)
}

export function queryAkashic(userId: string, q = '', limit = 20) {
  const like = `%${String(q).trim().slice(0, 100)}%`
  return {
    entities: db.prepare('select name,type,summary,props,updated_at from kg_entities where user_id=? and (name like ? or summary like ? or type like ?) order by updated_at desc limit ?').all(userId, like, like, like, limit)
      .map((e: any) => ({ ...e, props: e.props ? JSON.parse(e.props) : undefined })),
    relations: db.prepare('select src,rel,dst,note from kg_relations where user_id=? and (src like ? or dst like ? or rel like ?) order by id desc limit ?').all(userId, like, like, like, limit),
    decisions: db.prepare("select id,title,decision,rationale,status,created_at from kg_decisions where user_id=? and (title like ? or decision like ?) order by id desc limit ?").all(userId, like, like, limit),
    modules: db.prepare('select id,name,language,fossil_id,sha256,description,created_at from kg_modules where user_id=? and (name like ? or description like ?) order by id desc limit ?').all(userId, like, like, limit)
  }
}

export function deleteEntity(userId: string, name: string) {
  const n = norm(name)
  const c = Number(db.prepare('delete from kg_entities where user_id=? and name=?').run(userId, n).changes)
  db.prepare('delete from kg_relations where user_id=? and (src=? or dst=?)').run(userId, n, n)
  if (c) { appendRecord('akashic.entity.delete', { name: n }, { userId }); db.prepare('delete from mem_docs where source=?').run(`entity:${userId}:${n}`) }
  return c > 0
}
export function deleteDecision(userId: string, id: number) {
  const c = Number(db.prepare('delete from kg_decisions where user_id=? and id=?').run(userId, id).changes)
  if (c) { appendRecord('akashic.decision.delete', { id }, { userId }); db.prepare('delete from mem_docs where user_id=? and source=?').run(userId, `decision:${id}`) }
  return c > 0
}

// Compact "current state" block for the system prompt (bounded)
export function stateSummary(userId: string, maxChars = 1400): string {
  const ents = db.prepare("select name,type,summary from kg_entities where user_id=? and summary is not null order by updated_at desc limit 10").all(userId) as any[]
  const decs = db.prepare("select id,title,decision from kg_decisions where user_id=? and status='active' order by id desc limit 6").all(userId) as any[]
  const mods = db.prepare('select name,description from kg_modules where user_id=? order by id desc limit 6').all(userId) as any[]
  if (!ents.length && !decs.length && !mods.length) return ''
  const parts: string[] = []
  if (decs.length) parts.push('Active decisions:\n' + decs.map((d) => `- #${d.id} ${d.title}: ${String(d.decision).slice(0, 160)}`).join('\n'))
  if (ents.length) parts.push('Known entities:\n' + ents.map((e) => `- ${e.name}${e.type ? ` [${e.type}]` : ''}: ${String(e.summary).slice(0, 140)}`).join('\n'))
  if (mods.length) parts.push('Verified modules (fossils):\n' + mods.map((m) => `- ${m.name}: ${String(m.description || '').slice(0, 120)}`).join('\n'))
  const out = parts.join('\n')
  return out.length > maxChars ? out.slice(0, maxChars) + '…' : out
}
