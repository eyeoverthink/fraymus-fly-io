// Self-contained test for persistent memory, the public visitor chat and the generator-verifier loop.
// Boots throwaway servers (temp DATA_DIR) against a fake OpenAI-compatible LLM + embeddings server.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verify } from './verify-record.mjs'

const TOKEN = randomBytes(24).toString('hex')
let failures = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- fake LLM ----
const vec = (t) => { const v = new Array(64).fill(0); for (const w of String(t).toLowerCase().match(/[a-z0-9-]+/g) || []) v[createHash('md5').update(w).digest()[0] % 64] += 1; return v }
const CODES = ['zebra-42', 'biscuit-77', 'otter-9']
function fakeChat(body) {
  const msgs = body.messages, sys = msgs[0]?.content || '', last = msgs[msgs.length - 1]
  const tools = (body.tools || []).map((t) => t.function.name)
  const say = (content) => ({ choices: [{ message: { role: 'assistant', content } }] })
  const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  if (sys.startsWith('You are ARCHITECT')) {
    const fixed = last.content.includes('Feedback from the previous round')
    return say('NAME: add\nPATTERN: return the arithmetic sum, test with node:assert\n```js file=solution.mjs\nexport function add(a, b) { return ' + (fixed ? 'a + b' : 'a - b') + ' }\n```\n```js file=test.mjs\nimport assert from "node:assert/strict"\nimport { add } from "./solution.mjs"\nassert.equal(add(2, 3), 5)\nassert.equal(add(-1, 1), 0)\nconsole.log("tests passed")\n```')
  }
  if (sys.startsWith('You are CRITIC')) return say('{"blocking": false, "issues": []}')
  if (last.role === 'tool') return say('Noted.')
  const m = last.content.match(/remember (?:that )?(.+)/i)
  if (m && tools.includes('memory_save')) return call('memory_save', { text: m[1] })
  const p = last.content.match(/my project is (\S+)/i)
  if (p && tools.includes('akashic_upsert_entity')) return call('akashic_upsert_entity', { name: p[1], type: 'project', summary: 'visitor project' })
  const seen = CODES.filter((c) => sys.toLowerCase().includes(c))
  return say(`RECALL:${seen.join(',') || 'none'}`)
}
const llm = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}')
    const out = req.url.endsWith('/embeddings') ? { data: [].concat(body.input).map((t, i) => ({ index: i, embedding: vec(t) })) } : fakeChat(body)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
const LLM = `http://127.0.0.1:${llm.address().port}/v1`

async function boot(extra = {}, dataDir = mkdtempSync(join(tmpdir(), 'mem-test-'))) {
  const port = String(4300 + Math.floor(Math.random() * 400))
  const env = { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'openai', OPENAI_BASE_URL: LLM, OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'fake',
    EMBED_BASE_URL: LLM, EMBED_API_KEY: 'fake', SCHEDULER: 'off', NODE_ENV: 'test', WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: TOKEN, GROQ_API_KEY: '', CLERK_SECRET_KEY: '', SUPABASE_URL: '', FREE_CREDITS: '', ...extra }
  const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore', detached: true })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(400) }
  return { base, dataDir, stop: () => new Promise((r) => { p.on('exit', () => setTimeout(r, 300)); try { process.kill(-p.pid) } catch { p.kill() } }) }
}
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const api = async (s, path, opts = {}) => { const r = await fetch(s.base + path, { headers: opts.body ? H : { Authorization: H.Authorization }, ...opts }); return { status: r.status, body: await r.json().catch(() => null) } }
async function agentSay(s, message, threadId) {
  const r = await api(s, '/api/agent/runs', { method: 'POST', body: JSON.stringify({ agentId: 'concierge', message, threadId }) })
  const tid = r.body?.threadId
  for (let i = 0; i < 60; i++) {
    const t = (await api(s, `/api/agent/threads/${tid}`)).body
    if (t?.run && !['running', 'queued'].includes(t.run.status)) return { tid, reply: [...t.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '', run: t.run }
    await sleep(250)
  }
  return { tid, reply: '' }
}
class Visitor {
  constructor(s) { this.s = s; this.cookie = '' }
  async say(message, threadId) {
    const r = await fetch(this.s.base + '/public/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify({ message, threadId }) })
    const sc = r.headers.get('set-cookie'); if (sc && /fv=[^;]+/.test(sc)) this.cookie = sc.match(/fv=[^;]*/)[0]
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }
  async memory() { return (await fetch(this.s.base + '/public/memory', { headers: this.cookie ? { cookie: this.cookie } : {} })).json() }
}

const s = await boot()
let ownerThreadA, fossilId
try {
  // --- auth gate on new routes
  for (const [m, p] of [['GET', '/api/memory/status'], ['GET', '/api/memory/record/verify'], ['GET', '/api/memory/search?q=x'], ['GET', '/api/akashic'], ['POST', '/api/akashic/entities'],
    ['POST', '/api/evolve'], ['POST', '/api/evolve/execute'], ['GET', '/api/fossils'], ['GET', '/api/memory/record/export']]) {
    const r = await fetch(s.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })
    ok(r.status === 401, `no auth: ${m} ${p} -> 401 (${r.status})`)
  }
  const st = await api(s, '/api/memory/status')
  ok(st.status === 200 && st.body.record.ok, 'status: record chain ok')

  // --- owner memory across threads
  const a = await agentSay(s, 'remember that my build codename is zebra-42')
  ownerThreadA = a.tid
  ok(a.run?.status === 'done', `owner thread A run done (${a.run?.status})`)
  const b = await agentSay(s, 'what is my build codename?')
  ok(b.tid !== a.tid && b.reply.includes('zebra-42'), `owner: new thread B recalls fact from thread A (${b.reply})`)
  const mem = await api(s, '/api/agent/memories')
  ok(Array.isArray(mem.body) ? mem.body.some((m) => m.text.includes('zebra-42')) : JSON.stringify(mem.body).includes('zebra-42'), 'owner: memory_save still writes /api/agent/memories')
  const srch = await api(s, '/api/memory/search?q=codename')
  ok(srch.body.some((h) => h.text.includes('zebra-42')), 'owner: /api/memory/search finds the fact')

  // --- akashic
  const e1 = await api(s, '/api/akashic/entities', { method: 'POST', body: JSON.stringify({ name: 'fraymus-fly-io', type: 'project', summary: 'Fly app with persistent memory' }) })
  await api(s, '/api/akashic/relations', { method: 'POST', body: JSON.stringify({ src: 'fraymus-fly-io', rel: 'deploys_to', dst: 'Fly.io' }) })
  await api(s, '/api/akashic/decisions', { method: 'POST', body: JSON.stringify({ title: 'sandbox', decision: 'code runs only in the sandbox' }) })
  const ak = await api(s, '/api/akashic')
  ok(e1.status === 200 && ak.body.summary.includes('fraymus-fly-io') && ak.body.relations.length === 1 && ak.body.decisions.length === 1, 'akashic: entity, relation, decision stored and summarised')
  const ctx = await api(s, '/api/memory/context?q=deploy')
  ok(ctx.body.context.includes('AkashicRecord') && ctx.body.context.length <= 4100, 'akashic: summary injected into bounded prompt context')

  // --- sandbox
  const ex = async (code) => (await api(s, '/api/evolve/execute', { method: 'POST', body: JSON.stringify({ files: { 'test.mjs': code }, timeoutMs: 4000 }) })).body
  ok((await ex('console.log(1+1)')).passed, 'sandbox: plain test passes')
  ok(!(await ex('await fetch("http://example.com")')).passed, 'sandbox: fetch blocked')
  ok(!(await ex('import net from "node:net"; await new Promise((res, rej) => { const c = net.connect(80, "1.1.1.1"); c.on("connect", res); c.on("error", rej) })')).passed, 'sandbox: raw sockets blocked')
  ok(!(await ex('import fs from "node:fs"; fs.readFileSync("/etc/passwd")')).passed, 'sandbox: reading outside tmp dir blocked')
  ok(!(await ex('import cp from "node:child_process"; cp.execSync("id")')).passed, 'sandbox: child_process blocked')
  const inf = await ex('while(true){}')
  ok(!inf.passed && inf.timedOut, 'sandbox: infinite loop killed by timeout')
  const envr = await ex('if (Object.keys(process.env).some(k => /KEY|TOKEN|SECRET/.test(k))) process.exit(3)')
  ok(envr.passed, 'sandbox: no secrets in child env')

  // --- generator-verifier loop
  const ev = await api(s, '/api/evolve?wait=1', { method: 'POST', body: JSON.stringify({ task: 'export function add(a, b) that returns the sum', maxRounds: 3 }) })
  fossilId = ev.body?.fossilId
  ok(ev.body?.status === 'passed' && ev.body.rounds.length === 2 && !ev.body.rounds[0].exec.passed, `evolve: fails round 1, passes round 2 (${ev.body?.status}, ${ev.body?.rounds?.length})`)
  const fz = await api(s, `/api/fossils/${fossilId}`)
  ok(fz.status === 200 && fz.body.solution.includes('a + b'), 'evolve: fossil saved with passing solution')
  const pats = await api(s, '/api/memory/patterns')
  ok(pats.body.length === 1, 'evolve: proven pattern recorded')
  ok((await api(s, '/api/memory/context?q=sum')).body.context.includes('Proven patterns'), 'evolve: proven patterns injected into later prompts')

  // --- public visitor memory
  const v1 = new Visitor(s), v2 = new Visitor(s)
  const p1 = await v1.say('remember that my dog is named biscuit-77')
  ok(p1.status === 200 && v1.cookie.startsWith('fv=') && p1.tools.includes('memory_save'), 'public: anonymous chat works, sets visitor cookie, saves memory')
  await v1.say('my project is otter-9')
  const p2 = await v1.say('what is my dog named?')
  ok(p2.threadId !== p1.threadId && p2.reply.includes('biscuit-77') && p2.reply.includes('otter-9'), `public: visitor recalls across threads + own knowledge graph (${p2.reply})`)
  ok(!p2.reply.includes('zebra-42'), 'public: visitor never sees owner memory')
  const q2 = await v2.say('what is my dog named? what is my build codename? my project?')
  ok(!/biscuit-77|zebra-42|otter-9/.test(q2.reply), `public: second visitor sees nothing of visitor 1 or owner (${q2.reply})`)
  const forged = new Visitor(s); forged.cookie = v1.cookie.replace(/\.[^.]+$/, '.' + 'A'.repeat(22))
  const fr = await forged.say('what is my dog named?')
  ok(!fr.reply.includes('biscuit-77') && forged.cookie !== v1.cookie, 'public: forged visitor cookie gets a fresh empty identity')
  const steal = await v2.say('hi', p1.threadId)
  ok(steal.threadId !== p1.threadId, 'public: cannot continue another visitor\'s thread')
  ok(!(await api(s, '/api/memory/search?q=biscuit')).body.some((h) => h.text.includes('biscuit-77')), 'public: visitor data not mixed into owner scope')
  const vm = await v1.memory()
  ok(vm.visitor && vm.entities.some((e) => e.name === 'otter-9') && vm.memories.length >= 1, 'public: visitor can view own memory')
  for (const [m, p] of [['POST', '/api/evolve/execute'], ['POST', '/api/evolve'], ['GET', '/api/memory/search?q=zebra']]) {
    const r = await fetch(s.base + p, { method: m, headers: { 'content-type': 'application/json', cookie: v1.cookie }, body: m === 'POST' ? '{"files":{"test.mjs":"1"}}' : undefined })
    ok(r.status === 401, `public: visitor cookie cannot use ${m} ${p} (${r.status})`)
  }
  ok((await v1.say('x'.repeat(2001))).status === 413, 'public: oversized message rejected')

  // --- record chain: verify, digest-only visitor entries, tamper detection
  const ver = await api(s, '/api/memory/record/verify')
  ok(ver.body.ok && ver.body.entries > 10, `record: live chain verifies (${ver.body.entries} entries)`)
  const exp = await fetch(s.base + '/api/memory/record/export', { headers: H }).then((r) => r.text())
  ok(verify(exp).ok, 'record: exported copy verifies offline (scripts/verify-record.mjs)')
  ok(exp.includes('zebra-42') && !exp.includes('biscuit-77'), 'record: owner content kept, visitor content stored as digest only')
  const lines = exp.trim().split('\n'); const i = Math.floor(lines.length / 2)
  const t1 = [...lines]; t1[i] = t1[i].replace(/"ts":\d+/, '"ts":1'); 
  ok(!verify(t1.join('\n')).ok && verify(t1.join('\n')).brokenAt === i + 1, 'record: edited line detected')
  const t2 = [...lines]; t2.splice(i, 1)
  ok(!verify(t2.join('\n')).ok, 'record: deleted line detected')
  const tf = join(s.dataDir, 'tampered.jsonl'); writeFileSync(tf, t1.join('\n'))
  const cli = await new Promise((r) => spawn(process.execPath, ['scripts/verify-record.mjs', tf], { stdio: 'ignore' }).on('exit', r))
  ok(cli === 1, 'record: CLI exits 1 on tampered copy')
  const posted = await api(s, '/api/memory/record/verify', { method: 'POST', body: JSON.stringify({ jsonl: t1.join('\n') }) })
  ok(posted.body.ok === false, 'record: POST verify detects tampered copy')

  // --- cleanup paths
  ok((await api(s, `/api/agent/threads/${ownerThreadA}`, { method: 'DELETE' })).status === 200, 'cleanup: delete thread')
  ok(!(await api(s, '/api/memory/search?q=codename')).body.some((h) => h.threadId === ownerThreadA), 'cleanup: deleted thread removed from semantic store')
  ok((await api(s, `/api/fossils/${fossilId}`, { method: 'DELETE' })).status === 200 && (await api(s, '/api/memory/patterns')).body.length === 0, 'cleanup: fossil + pattern deleted')
  const fg = await fetch(s.base + '/public/memory', { method: 'DELETE', headers: { cookie: v2.cookie } })
  ok(fg.status === 200 && !(await v2.memory()).visitor, 'public: forget-me deletes visitor memory')
} finally { await s.stop() }

// --- retention: expired visitors are purged on boot
{
  const r1 = await boot()
  const v = new Visitor(r1)
  await v.say('remember that my cat is otter-9')
  await r1.stop()
  const d = new DatabaseSync(join(r1.dataDir, 'agent.db')); d.prepare('update visitors set last_seen=0').run(); d.close()
  const r2 = await boot({}, r1.dataDir); v.s = r2
  const m = await v.memory()
  ok(!m.visitor || m.docs === 0, 'public: visitors past the retention limit are purged')
  await r2.stop(); rmSync(r1.dataDir, { recursive: true, force: true })
}

// --- rate limits and daily cap
{
  const r = await boot({ PUBLIC_VISITOR_PER_10MIN: '3', PUBLIC_DAILY_CAP: '5', PUBLIC_NEW_VISITORS_PER_IP_DAY: '3' })
  try {
    const v = new Visitor(r), codes = []
    for (let i = 0; i < 4; i++) codes.push((await v.say('hello ' + i)).status)
    ok(codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, `rate limit: per-visitor window (${codes})`)
    const w = new Visitor(r); const c2 = [(await w.say('a')).status, (await w.say('b')).status, (await w.say('c')).status]
    ok(c2[0] === 200 && c2[1] === 200 && c2[2] === 429, `rate limit: global daily cap (${c2})`)
    const fresh = []; for (let i = 0; i < 2; i++) fresh.push((await new Visitor(r).say('new')).status)
    ok(fresh.every((c) => c === 429), `rate limit: new visitor ids per IP capped (${fresh})`)
  } finally { await r.stop(); rmSync(r.dataDir, { recursive: true, force: true }) }
}

rmSync(s.dataDir, { recursive: true, force: true })
llm.close()
console.log(failures ? `\n${failures} memory check(s) FAILED` : '\nall memory checks passed')
process.exit(failures ? 1 : 0)
