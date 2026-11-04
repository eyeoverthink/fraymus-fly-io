// Self-contained end-to-end test for the FRAYMUS Logic Chain integration (server/logic-chain): boots this app with the
// vendored Python sidecar on loopback, runs a MOCK chain through the HTTP API, checks the MOCK label everywhere, the
// signed-chain verify (and that tampering is caught), the Library items, skill registration per agent, the agent tools
// over MCP, the spend guards on live runs, and the record events. No provider key is set, so nothing touches the network.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { verify } from './verify-record.mjs'

const TOKEN = randomBytes(24).toString('hex')
let failures = 0, passes = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PY = process.env.LOGIC_CHAIN_PYTHON || 'python3'
if (spawnSync(PY, ['-c', 'import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)']).status !== 0) { console.log('skip: python3 >= 3.10 not installed'); process.exit(0) }

const dataDir = mkdtempSync(join(tmpdir(), 'logic-chain-test-'))
const port = String(5700 + Math.floor(Math.random() * 250))
// Every provider key blanked: the run must be MOCK and must not reach the network.
const env = { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'none', SCHEDULER: 'off', NODE_ENV: 'test', WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: TOKEN,
  GROQ_API_KEY: '', CLERK_SECRET_KEY: '', SUPABASE_URL: '', FREE_CREDITS: '', LIBRARY_SYNC_MS: '600000', REPLICATE_API_TOKEN: '', FAL_KEY: '', HF_TOKEN: '',
  XAI_API_KEY: '', PROMPT_LLM_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', FRAYMUS_IDENTITY_FILE: '', FRAYMUS_IDENTITY_SEED: '', LOGIC_CHAIN: '', LOGIC_CHAIN_URL: '', LOGIC_CHAIN_POLL_MS: '300',
  LOGIC_CHAIN_MAX_RUN_CENTS: '', LOGIC_CHAIN_MAX_PLAN_CALLS: '' }
const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore', detached: true })
const base = `http://127.0.0.1:${port}`
const stop = () => new Promise((r) => { p.on('exit', () => setTimeout(r, 300)); try { process.kill(-p.pid) } catch { p.kill() } })
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const raw = (path, opts = {}) => fetch(base + path, { ...opts, headers: { ...AUTH, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } })
const api = async (path, opts = {}) => { const r = await raw(path, opts); return { status: r.status, body: await r.json().catch(() => null) } }
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
async function until(id, ms = 120_000) {
  const t = Date.now(); let r
  while (Date.now() - t < ms) { r = (await api(`/api/logic-chain/runs/${id}`)).body; if (r && r.library?.run && !['running', 'finalizing'].includes(r.status)) return r; await sleep(400) }
  return r
}
const OBJ = 'Design a rate limiter for a public JSON API: per-key token buckets, burst handling, and how to test it.'

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(400) }
  let st
  for (let i = 0; i < 60; i++) { st = (await api('/api/logic-chain/status')).body; if (st?.ready || st?.error) break; await sleep(300) }

  // --- gate + status
  ok((await fetch(base + '/api/logic-chain/status')).status === 401, 'gate: /api/logic-chain needs the workspace token')
  ok((await fetch(base + '/api/logic-chain/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'x' }) })).status === 401, 'gate: POST /runs without a token is 401')
  ok(st?.ready === true && st.sidecar === 'child' && /^127\.0\.0\.1:\d+$/.test(st.listen || ''), `status: sidecar ready on loopback (${st?.listen}, python ${st?.python})`)
  ok(st?.vendored?.commit === 'c0771d0373d960dbcc961adf3226cf5109d38af8', 'status: reports the pinned upstream commit')
  ok(st?.defaultMode === 'mock' && st.liveAvailable === false, 'status: default mode mock, live unavailable with no keys')
  ok(st?.identity?.source === 'local' && /LOCAL KEY/.test(st.identity.label), 'status: no identity configured -> clearly labelled LOCAL KEY')
  ok(st?.caps?.maxRunCents === 100 && st.caps.maxPlanCalls === 60, 'status: default spend caps $1.00 / 60 calls')
  ok(!JSON.stringify(st).includes(TOKEN) && !/"token"/i.test(JSON.stringify(st)), 'status: no token in the status payload')

  // --- input + spend guards
  ok((await post('/api/logic-chain/runs', {})).status === 400, 'runs: objective required')
  ok((await post('/api/logic-chain/runs', { objective: 'x'.repeat(12_001) })).status === 400, 'runs: objective over 12000 chars rejected')
  ok((await post('/api/logic-chain/runs', { objective: 'x', mode: 'turbo' })).status === 400, 'runs: unknown mode rejected')
  const live = await post('/api/logic-chain/runs', { objective: 'x', mode: 'live', approveSpend: true })
  ok(live.status === 400 && /no provider key/.test(live.body?.error || ''), 'runs: live refused when no provider key is set')
  ok((await post('/api/logic-chain/runs', { objective: 'x', maxUsd: 0 })).status === 400, 'runs: maxUsd below $0.01 rejected')

  // --- a MOCK run end to end
  const t0 = Date.now()
  const start = await post('/api/logic-chain/runs', { objective: OBJ })
  ok(start.status === 202 && start.body?.id && start.body.label === 'MOCK' && start.body.requestedMode === 'mock', `runs: POST -> 202, labelled MOCK from the start (${start.body?.id})`)
  const id = start.body?.id
  const done = await until(id)
  ok(done?.status === 'complete', `runs: mock run complete in ${((Date.now() - t0) / 1000).toFixed(1)}s (status ${done?.status})`)
  ok(done?.mode === 'mock' && done.label === 'MOCK', 'runs: mode mock, label MOCK')
  ok(done?.stages?.length === 16 && done.stages.every((s) => s.kind === 'demo' && s.status === 'complete'), `runs: 16 stages (8 seats x 2 passes), all demo fixtures (${done?.stages?.length})`)
  ok(/^fx-/.test(done?.signer || '') && done.verified === true, `runs: signed by ${done?.signer}, verified on completion`)
  ok(!/\bLIVE\b/.test(JSON.stringify(done)), 'runs: the word LIVE appears nowhere in a mock run view')
  ok(done?.brief && done.links?.verify === `/api/logic-chain/runs/${id}/verify`, 'runs: brief and links present')
  const list = (await api('/api/logic-chain/runs')).body
  ok(Array.isArray(list?.runs) && list.runs.some((r) => r.id === id), 'runs: listed')
  const full = (await api(`/api/logic-chain/runs/${id}?full=1`)).body
  ok(full?.run?.audit?.records?.length >= 18 && full.run.audit.records.every((x) => x.sig && x.link), `runs: ?full=1 returns run.json with ${full?.run?.audit?.records?.length} signed records`)
  ok((await api('/api/logic-chain/runs/nope')).status === 404, 'runs: unknown id 404')

  // --- verify
  const v = (await api(`/api/logic-chain/runs/${id}/verify`)).body
  ok(v?.ok === true && v.records >= 18 && /^[0-9a-f]{64}$/.test(v.head || '') && v.label === 'MOCK', `verify: ok, ${v?.records} records, head ${String(v?.head).slice(0, 12)}…, label MOCK`)
  ok(v?.package?.ok === true, `verify: skill package verifies too (errors: ${(v?.package?.errors || []).length})`)

  // --- document
  const dr = await raw(`/api/logic-chain/runs/${id}/document`)
  const doc = await dr.text()
  ok(dr.status === 200 && /markdown/.test(dr.headers.get('content-type') || '') && /MOCK run/.test(doc) && doc.includes('rate limiter'), 'document: markdown with the MOCK banner and the objective')

  // --- Library: brief, run.json, skill package
  const lib = (await api('/api/library?type=logic&limit=50')).body
  const mine = (lib?.items || []).filter((x) => x.meta?.runId === id)
  const kinds = mine.map((x) => x.meta.kind).sort().join()
  ok(mine.length === 3 && kinds === 'brief,run.json,skill', `library: 3 items of type logic (${kinds})`)
  ok(mine.every((x) => x.title.startsWith('[MOCK]') && x.tags.includes('MOCK') && x.meta.label === 'MOCK'), 'library: every item titled and tagged MOCK')
  ok(mine.every((x) => x.meta.links?.verify && x.meta.links.library?.brief === done.library.brief && x.meta.links.library.run === done.library.run), 'library: items link to each other and to the API')
  const runItem = (await api(`/api/library/items/${done.library.run}`)).body
  ok(runItem?.data?.audit?.records?.length === full.run.audit.records.length && runItem.meta.verified === true, 'library: run.json item stores the full signed run')
  const skillItem = (await api(`/api/library/items/${done.library.skill}`)).body
  ok(skillItem?.data?.manifest?.status === 'candidate_unverified' && /CONTRACT|Contract|contract/.test(skillItem.content || '') && (skillItem.data.files['tests/test_acceptance.py'] || '').includes('def test'), 'library: skill item stores skill.json, CONTRACT.md and acceptance tests')

  // --- skills: registered, enabled for no agent by default
  const sk = (await api('/api/logic-chain/skills')).body
  const skill = sk?.skills?.find((s) => s.runId === id)
  ok(skill && Array.isArray(skill.agents) && skill.agents.length === 0 && skill.executable === false && skill.label === 'MOCK', `skills: ${skill?.id} registered, enabled for no agent, not executable`)
  ok((await post(`/api/logic-chain/skills/${skill?.id}/agents`, { agents: ['no_such_agent'] })).status === 400, 'skills: unknown agent id rejected')
  ok((await post(`/api/logic-chain/skills/${skill?.id}/agents`, { agents: 'forge_keeper' })).status === 400, 'skills: agents must be an array')
  const en = (await post(`/api/logic-chain/skills/${skill?.id}/agents`, { agents: ['forge_keeper'] })).body
  ok(en?.agents?.join() === 'forge_keeper', 'skills: enabled for forge_keeper')
  ok((await api(`/api/logic-chain/skills/${skill?.id}`)).body?.manifest?.id === skill?.id, 'skills: full manifest readable')

  // --- agent tools over MCP (the same registry the agents use)
  const tok = (await post('/api/access/tokens', { name: 'lc-admin', scopes: ['admin'] })).body?.token
  const c = new Client({ name: 'lc-test', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }))
  const callTool = async (name, args) => { const r = await c.callTool({ name: 'call_tool', arguments: { name, arguments: args } }); const t = r.content.map((x) => x.text).join(''); try { return JSON.parse(t) } catch { return { _raw: t } } }
  const ts = await callTool('logic_chain_status', { runId: id })
  ok(ts?.id === id && ts.label === 'MOCK', 'tool: logic_chain_status returns the run, labelled MOCK')
  const tv = await callTool('logic_chain_verify', { runId: id })
  ok(tv?.ok === true && tv.records === v.records, 'tool: logic_chain_verify ok')
  const tk = await callTool('logic_chain_skills', {})
  ok(Array.isArray(tk?.skills) && tk.skills.length === 0, 'tool: logic_chain_skills shows nothing to an agent the skill is not enabled for')
  const tr = await callTool('logic_chain_run', { objective: 'Plan a nightly backup job for a SQLite file with a restore drill.' })
  ok(tr?.status === 'complete' && tr.label === 'MOCK' && tr.library?.skill, `tool: logic_chain_run (mock) completes and lands in the Library (${tr?.id})`)
  await c.close()

  // --- tamper detection on the stored run.json
  const file = join(dataDir, 'logic-chain', 'runs', `${id}.json`)
  const j = JSON.parse(readFileSync(file, 'utf8'))
  j.stages[0].model = j.stages[0].model + '-edited'
  writeFileSync(file, JSON.stringify(j))
  const vt = (await api(`/api/logic-chain/runs/${id}/verify`)).body
  ok(vt?.ok === false && vt.errors?.length > 0, `verify: an edited record is caught (${(vt?.errors || [])[0]?.slice(0, 80)})`)

  // --- record events
  const exp = await (await raw('/api/memory/record/export')).text()
  ok(verify(exp).ok && ['logic.run.start', 'logic.run.done', 'logic.skill.agents'].every((k) => exp.includes(`"kind":"${k}"`)), 'record: logic events logged, chain verifies')
  ok(!exp.includes(TOKEN), 'record: no token in the record')
} catch (e) { console.error(e); failures++ } finally {
  await stop()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}
