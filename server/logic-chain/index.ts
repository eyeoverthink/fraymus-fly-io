// FRAYMUS Logic Chain: eight model seats, two passes, one signed (Ed25519, hash-linked) audit chain per run.
// The chain itself is the vendored Python app in vendor/logic-chain (a copied subtree pinned to one upstream commit;
// see vendor/logic-chain/UPSTREAM.md). Node runs it as a loopback-only sidecar child process (127.0.0.1, random
// port, random per-boot bearer token, allow-listed environment) and proxies a small API under /api/logic-chain.
// Every finished run is saved to the Library (type "logic"): the brief, the signed run.json and the candidate skill
// package, linked to each other. Skill packages become selectable skills for agents, enabled for no agent by default.
// Runs are MOCK (demo fixtures, no network, no cost) unless a caller asks for mode "live" AND approves the spend;
// live runs use only server-side provider keys and stop at a cost cap and a call cap.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { db, now } from '../agent/db'
import { loadManifests } from '../agent/manifest'
import { registerTools, type Tool } from '../agent/tools'
import { appendRecord } from '../memory/record'
import { isOwner, libItemId, upsertItem } from '../library'

export const LOGIC_CHAIN_COMMIT = 'c0771d0373d960dbcc961adf3226cf5109d38af8'
const AGENT = 'logic-chain'
const MAX_REQUEST = 12000 // vendor/logic-chain/app/engine.py MAX_REQUEST
const FINISHED = ['complete', 'partial_failure', 'failed', 'cancelled', 'budget_exceeded', 'interrupted']
const DATA = () => resolve(process.env.DATA_DIR || './data')
export const chainDir = () => resolve(process.env.LOGIC_CHAIN_DIR || './vendor/logic-chain')
export const chainDataDir = () => join(DATA(), 'logic-chain')
const PY = () => process.env.LOGIC_CHAIN_PYTHON || 'python3'
const int = (v: any, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d }
const clip = (s: any, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const parse = (s: any, d: any = null) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Spending caps. Live runs stop at whichever comes first; a request may lower them but never raise them. */
export const caps = () => ({
  maxRunCents: int(process.env.LOGIC_CHAIN_MAX_RUN_CENTS, 100, 1, 100_000), // $1.00 per run
  maxPlanCalls: int(process.env.LOGIC_CHAIN_MAX_PLAN_CALLS, 60, 1, 10_000),
  maxElapsedSeconds: int(process.env.LOGIC_CHAIN_MAX_SECONDS, 3600, 60, 86_400)
})

// ---------- provider keys (server-side env names only; values never leave this process except to the sidecar) ----------
const ROLES: [string, string][] = [
  ['Architect', 'Define the components, their boundaries and how they fit together.'],
  ['Algorithm', 'Specify the core procedures, their inputs, outputs and complexity.'],
  ['Data Model', 'Specify the data, state, schemas and how state changes over time.'],
  ['Implementation', 'Turn the design into concrete build steps, in order.'],
  ['Critic', 'Attack assumptions. Name what would fail, conflict, or is unproven.'],
  ['Test Designer', 'Propose specific checks that could prove this design wrong.'],
  ['Optimizer', 'Find waste, bottlenecks and simpler alternatives; say what to measure first.'],
  ['Integrator', 'Resolve loose ends and state what is still missing before this can ship.']
]
const isXai = (url: string) => { try { return /(^|\.)x\.ai$/.test(new URL(url).hostname) } catch { return false } }
type Key = { name: string; value: string; from: string }
function providerKeys(): Record<'xai' | 'openai' | 'gemini', Key | null> {
  const env = process.env
  // xAI: XAI_API_KEY, else the app's existing prompt-step key when that step already points at api.x.ai (fly.toml).
  const xai = env.XAI_API_KEY ? { name: 'XAI_API_KEY', value: env.XAI_API_KEY, from: 'XAI_API_KEY' }
    : env.PROMPT_LLM_API_KEY && isXai(env.PROMPT_LLM_BASE_URL || '') ? { name: 'XAI_API_KEY', value: env.PROMPT_LLM_API_KEY, from: 'PROMPT_LLM_API_KEY' } : null
  const openai = env.OPENAI_API_KEY ? { name: 'OPENAI_API_KEY', value: env.OPENAI_API_KEY, from: 'OPENAI_API_KEY' } : null
  const gemini = env.GEMINI_API_KEY ? { name: 'GEMINI_API_KEY', value: env.GEMINI_API_KEY, from: 'GEMINI_API_KEY' } : null
  return { xai, openai, gemini }
}
const enabledProviders = () => (process.env.LOGIC_CHAIN_PROVIDERS || 'xai,gemini,openai').split(',').map((s) => s.trim()).filter(Boolean)
type Seat = { provider: string; kind: string; model: string; url?: string; key_env?: string }
export function liveSeats(): Seat[] {
  const k = providerKeys(), env = process.env, seats: Seat[] = []
  for (const p of enabledProviders()) {
    if (p === 'xai' && k.xai) seats.push({ provider: 'xai', kind: 'openai_compatible', model: env.LOGIC_CHAIN_XAI_MODEL || 'grok-4.3', url: 'https://api.x.ai/v1/chat/completions', key_env: 'XAI_API_KEY' })
    if (p === 'gemini' && k.gemini) seats.push({ provider: 'gemini', kind: 'gemini', model: env.LOGIC_CHAIN_GEMINI_MODEL || 'gemini-3.5-flash-lite', key_env: 'GEMINI_API_KEY' })
    if (p === 'openai' && k.openai) {
      // OPENAI_BASE_URL (e.g. the Hostinger router) is honoured the same way the agents use it.
      const base = (env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
      seats.push(base ? { provider: 'openai', kind: 'openai_compatible', model: env.LOGIC_CHAIN_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini', url: `${base}/chat/completions`, key_env: 'OPENAI_API_KEY' }
        : { provider: 'openai', kind: 'openai', model: env.LOGIC_CHAIN_OPENAI_MODEL || 'gpt-4.1-mini', key_env: 'OPENAI_API_KEY' })
    }
  }
  return seats
}
export function chainConfig(mode: 'mock' | 'live', limits = caps()) {
  const seats = mode === 'live' ? liveSeats() : []
  const slots = ROLES.map(([name, focus], i) => {
    if (mode === 'mock') return { name, kind: 'demo', model: 'fixture', focus }
    // Count back from the last role so the Integrator (which also writes the brief) gets the first-listed provider.
    const s = seats[(((i - ROLES.length + 1) % seats.length) + seats.length) % seats.length]
    const { provider: _p, ...slot } = s
    return { name, ...slot, focus }
  })
  return {
    slots, passes: 2, allow_remote: mode === 'live', synthesize: true, review: true,
    max_run_cents: limits.maxRunCents, max_plan_calls: limits.maxPlanCalls, max_elapsed_seconds: limits.maxElapsedSeconds,
    timeout_seconds: 300, retries: 1, max_output_tokens: mode === 'live' ? 8000 : 1500, max_context_chars: mode === 'live' ? 40000 : 16000, num_ctx: 16384
  }
}

// ---------- signing identity ----------
type Identity = { source: 'FRAYMUS_IDENTITY_FILE' | 'FRAYMUS_IDENTITY_SEED' | 'local'; label: string; file?: string; error?: string }
let seedDir: string | null = null
export function resolveIdentity(): Identity {
  const file = process.env.FRAYMUS_IDENTITY_FILE, seed = (process.env.FRAYMUS_IDENTITY_SEED || '').trim()
  if (file) {
    // The Python side would silently create a NEW key at a missing path; refuse instead so a typo can't swap identities.
    if (!existsSync(file)) return { source: 'FRAYMUS_IDENTITY_FILE', label: 'configured identity file is missing', error: 'FRAYMUS_IDENTITY_FILE points at a file that does not exist' }
    return { source: 'FRAYMUS_IDENTITY_FILE', label: 'configured (FRAYMUS_IDENTITY_FILE)', file }
  }
  if (seed) {
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) return { source: 'FRAYMUS_IDENTITY_SEED', label: 'configured seed is invalid', error: 'FRAYMUS_IDENTITY_SEED must be 64 hex characters (a 32-byte Ed25519 seed)' }
    // Written to a private temp file (not the data volume) only so the sidecar can load it; removed on exit.
    seedDir ||= mkdtempSync(join(tmpdir(), 'fraymus-id-'))
    chmodSync(seedDir, 0o700)
    const path = join(seedDir, 'ed25519.seed')
    writeFileSync(path, seed.toLowerCase() + '\n', { mode: 0o600 })
    return { source: 'FRAYMUS_IDENTITY_SEED', label: 'configured (FRAYMUS_IDENTITY_SEED secret)', file: path }
  }
  return { source: 'local', label: 'LOCAL KEY: auto-generated on this server (DATA_DIR/logic-chain/identity), not your Fraymus identity' }
}

// ---------- sidecar ----------
type Side = { proc: ChildProcess | null; base: string; token: string; ready: boolean; external: boolean; error: string | null; python: string | null; restarts: number; log: string[]; identity: Identity; stopping: boolean }
const side: Side = { proc: null, base: '', token: '', ready: false, external: false, error: null, python: null, restarts: 0, log: [], identity: { source: 'local', label: '' }, stopping: false }
export const enabled = () => !/^(off|0|false|no)$/i.test(process.env.LOGIC_CHAIN || '')

function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)) }) })
}
function pythonVersion(): string | null {
  const r = spawnSync(PY(), ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3]);sys.exit(0 if sys.version_info>=(3,10) else 3)'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : null
}
// Only what the chain needs. Workspace tokens, Shopify/Resend/Clerk secrets etc. never reach the Python process.
export function sidecarEnv(port: number, withKeys = true) {
  const e = process.env, out: Record<string, string> = {}
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT']) if (e[k]) out[k] = e[k]!
  Object.assign(out, { HOME: chainDataDir(), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', FRAYMUS_HOST: '127.0.0.1', FRAYMUS_PORT: String(port), FRAYMUS_DATA_DIR: chainDataDir(), FRAYMUS_SERVER_TOKEN: side.token })
  // Ollama is off by default on Fly (nothing listens); a configured OLLAMA_HOST is passed through for local installs.
  out.FRAYMUS_OLLAMA_URL = (e.LOGIC_CHAIN_OLLAMA_URL || e.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  if (side.identity.file) out.FRAYMUS_IDENTITY_FILE = side.identity.file
  if (withKeys) for (const k of Object.values(providerKeys())) if (k) out[k.name] = k.value
  return out
}
// The child exits when its stdin closes, so it can never outlive this Node process (crash, SIGKILL, container stop).
const LAUNCH = "import os,sys,threading,runpy\ndef w():\n  sys.stdin.read()\n  os._exit(0)\nthreading.Thread(target=w,daemon=True).start()\nsys.argv=['run.py']\nrunpy.run_path('run.py',run_name='__main__')"

async function startSidecar() {
  side.identity = resolveIdentity()
  if (process.env.LOGIC_CHAIN_URL) {
    // An already-running Logic Chain on this machine's loopback (its Host check only accepts 127.0.0.1/localhost).
    side.external = true; side.base = process.env.LOGIC_CHAIN_URL.replace(/\/+$/, ''); side.token = process.env.FRAYMUS_SERVER_TOKEN || ''
    side.ready = await waitReady(5_000); if (!side.ready) side.error = `LOGIC_CHAIN_URL ${side.base} is not answering`
    return
  }
  if (!existsSync(join(chainDir(), 'run.py'))) { side.error = `Logic Chain code not found at ${chainDir()}`; return }
  side.python = pythonVersion()
  if (!side.python) { side.error = `${PY()} (3.10+) not found; install python3 or set LOGIC_CHAIN_PYTHON`; return }
  mkdirSync(chainDataDir(), { recursive: true })
  const port = process.env.LOGIC_CHAIN_PORT ? int(process.env.LOGIC_CHAIN_PORT, 8765, 1, 65535) : await freePort()
  side.token = randomBytes(24).toString('hex')
  side.base = `http://127.0.0.1:${port}`
  const p = spawn(PY(), ['-c', LAUNCH], { cwd: chainDir(), env: sidecarEnv(port), stdio: ['pipe', 'pipe', 'pipe'] })
  side.proc = p
  const add = (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) side.log = [...side.log, clip(l, 300)].slice(-40) }
  p.stdout!.on('data', add); p.stderr!.on('data', add)
  p.on('error', (e) => { side.error = `sidecar failed to start: ${e.message}` })
  p.on('exit', (code) => {
    side.ready = false; side.proc = null
    if (side.stopping) return
    side.error = `sidecar exited (code ${code}); restarting`
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(side.restarts++, 5))
    setTimeout(() => { startSidecar().catch((e) => { side.error = String(e?.message || e) }) }, wait).unref()
  })
  side.ready = await waitReady(20_000)
  if (side.ready) { side.error = null; console.log(`[logic-chain] sidecar ready on ${side.base} (python ${side.python}, identity: ${side.identity.label})`) }
  else if (!side.error) side.error = 'sidecar did not become ready in 20s'
}
async function waitReady(ms: number) {
  const t = Date.now()
  while (Date.now() - t < ms) { try { if ((await lc('/api/config')).status === 200) return true } catch {} await sleep(250) }
  return false
}
export function stopSidecar() {
  side.stopping = true
  try { side.proc?.kill() } catch {}
  if (seedDir) try { rmSync(seedDir, { recursive: true, force: true }) } catch {}
}

async function lc(path: string, init: { method?: string; body?: any; text?: boolean; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = {}
  if (side.token) headers.Authorization = `Bearer ${side.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(side.base + path, { method: init.method || (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(init.timeoutMs || 20_000) })
  const text = await r.text()
  return { status: r.status, text, body: init.text ? null : parse(text, null) as any }
}
class HttpError extends Error { constructor(public code: number, msg: string) { super(msg) } }
const needReady = () => { if (!enabled()) throw new HttpError(503, 'Logic Chain is disabled (LOGIC_CHAIN=off)'); if (!side.ready) throw new HttpError(503, `Logic Chain sidecar is not ready: ${side.error || 'starting'}`) }

// ---------- runs ----------
db.exec(`create table if not exists logic_runs(id text primary key, user_id text not null, objective text, requested_mode text, mode text, label text, status text,
  signer text, verified integer, lib text, skill_id text, error text, caps text, created_at integer, updated_at integer);
create index if not exists idx_logic_user on logic_runs(user_id, created_at);
create table if not exists logic_skills(id text primary key, run_id text not null, user_id text not null, title text, mode text, label text, manifest text, agents text default '[]', created_at integer);`)
type Row = { id: string; user_id: string; objective: string; requested_mode: string; mode: string | null; label: string; status: string; signer: string | null; verified: number | null; lib: string | null; skill_id: string | null; error: string | null; caps: string; created_at: number; updated_at: number }
const load = (id: string, userId?: string) => db.prepare(`select * from logic_runs where id=?${userId ? ' and user_id=?' : ''}`).get(...(userId ? [id, userId] : [id])) as Row | undefined

/** MOCK when every stage ran on demo fixtures. Never LIVE unless every stage used a real provider. */
export function labelOf(run: any, requested?: string) {
  const kinds = new Set<string>((run?.stages || []).map((s: any) => s.kind || 'demo'))
  if (run?.mode === 'mock' || (kinds.size && [...kinds].every((k) => k === 'demo'))) return 'MOCK'
  if (run?.mode === 'mixed' || kinds.has('demo')) return 'MIXED (part MOCK)'
  if (run?.mode === 'real' || kinds.size) return 'LIVE'
  return requested === 'mock' ? 'MOCK' : 'PENDING'
}
const links = (id: string) => ({ api: `/api/logic-chain/runs/${id}`, verify: `/api/logic-chain/runs/${id}/verify`, document: `/api/logic-chain/runs/${id}/document`, runJson: `/api/logic-chain/runs/${id}?full=1` })
function view(r: Row, run?: any, full = false) {
  const lib = parse(r.lib, {})
  return {
    id: r.id, objective: r.objective, status: run?.status || r.status, requestedMode: r.requested_mode, mode: run?.mode || r.mode, label: run ? labelOf(run, r.requested_mode) : r.label,
    signer: run?.audit?.signer || r.signer, verified: r.verified == null ? null : !!r.verified, error: r.error || run?.stop_reason || undefined, caps: parse(r.caps, {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
    stages: run ? (run.stages || []).map((s: any) => ({ number: s.number, pass: s.pass, name: s.name, kind: s.kind, model: s.model, status: s.status, error: s.error ? clip(s.error, 300) : undefined })) : undefined,
    summary: run?.summary, usage: run?.usage?.all, brief: run?.synthesis?.text ? clip(run.synthesis.text, full ? 200_000 : 4000) : undefined,
    library: { brief: lib.brief || null, run: lib.run || null, skill: lib.skill || null }, skillId: r.skill_id, links: links(r.id),
    ...(full && run ? { run } : {})
  }
}

let lock: Promise<any> = Promise.resolve()
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = lock.then(fn, fn); lock = next.catch(() => {}); return next }

export async function createRun(userId: string, body: any, agentId?: string) {
  needReady()
  if (side.identity.error) throw new HttpError(503, side.identity.error)
  const objective = String(body?.objective ?? body?.request ?? '').trim()
  if (!objective) throw new HttpError(400, 'objective required')
  if (objective.length > MAX_REQUEST) throw new HttpError(400, `objective cannot exceed ${MAX_REQUEST} characters`)
  const mode: 'mock' | 'live' = body?.mode === 'live' ? 'live' : 'mock'
  if (body?.mode && !['mock', 'live'].includes(body.mode)) throw new HttpError(400, 'mode must be "mock" or "live"')
  const limits = caps()
  if (body?.maxUsd != null) { const c = Math.round(Number(body.maxUsd) * 100); if (!(c >= 1)) throw new HttpError(400, 'maxUsd must be at least 0.01'); limits.maxRunCents = Math.min(c, limits.maxRunCents) }
  if (body?.maxPlanCalls != null) { const c = Number(body.maxPlanCalls); if (!Number.isInteger(c) || c < 1) throw new HttpError(400, 'maxPlanCalls must be a positive whole number'); limits.maxPlanCalls = Math.min(c, limits.maxPlanCalls) }
  if (mode === 'live') {
    if (!isOwner(userId)) throw new HttpError(403, 'live runs spend provider credit and are limited to the workspace owner')
    if (!liveSeats().length) throw new HttpError(400, 'no provider key is set on the server (XAI_API_KEY or PROMPT_LLM_API_KEY with an x.ai base URL, GEMINI_API_KEY, OPENAI_API_KEY); use mode "mock"')
    if (body?.approveSpend !== true) throw new HttpError(400, `live runs need approveSpend: true (cap $${(limits.maxRunCents / 100).toFixed(2)}, ${limits.maxPlanCalls} calls)`)
  }
  return serial(async () => {
    const cfg = await lc('/api/config', { body: chainConfig(mode, limits) })
    if (cfg.status === 409) throw new HttpError(409, 'another Logic Chain run is in progress; wait for it or cancel it')
    if (cfg.status !== 200) throw new HttpError(502, `Logic Chain rejected the config: ${cfg.body?.error || cfg.status}`)
    const r = await lc('/api/run', { body: { request: objective, approve_remote: mode === 'live' } })
    if (r.status === 409) throw new HttpError(409, 'another Logic Chain run is in progress; wait for it or cancel it')
    if (r.status !== 202 || !r.body?.id) throw new HttpError(r.status >= 400 && r.status < 500 ? r.status : 502, `Logic Chain did not start: ${r.body?.error || r.status}`)
    const id = String(r.body.id), t = now(), label = mode === 'mock' ? 'MOCK' : 'PENDING'
    db.prepare("insert into logic_runs(id,user_id,objective,requested_mode,mode,label,status,caps,created_at,updated_at) values(?,?,?,?,?,?,'running',?,?,?)")
      .run(id, userId, objective, mode, null, label, JSON.stringify(limits), t, t)
    appendRecord('logic.run.start', { runId: id, mode, label, caps: limits, identity: side.identity.source }, { userId, agentId: agentId || AGENT })
    poll()
    return view(load(id)!)
  })
}

export async function getRun(userId: string, id: string, full = false) {
  const r = load(id, userId); if (!r) return null
  if (!side.ready) return view(r)
  const run = (await lc(`/api/runs/${encodeURIComponent(id)}`)).body
  return view(load(id)!, run?.id ? run : undefined, full)
}
export const listRuns = (userId: string) => (db.prepare('select * from logic_runs where user_id=? order by created_at desc limit 50').all(userId) as Row[]).map((r) => view(r))

/** The run's signed chain checked by the vendored verifier, plus its skill package when one was exported. */
export async function verifyRun(userId: string, id: string) {
  const r = load(id, userId); if (!r) return null
  needReady()
  const v = await lc(`/api/runs/${encodeURIComponent(id)}/verify`)
  if (v.status !== 200) throw new HttpError(v.status === 404 ? 404 : 502, v.body?.error || `verify failed (${v.status})`)
  let pkg: any = null
  if (r.skill_id && !side.external) {
    const folder = join(chainDataDir(), 'skills', r.skill_id)
    if (existsSync(folder)) {
      const out = spawnSync(PY(), ['run.py', 'verify', folder], { cwd: chainDir(), env: sidecarEnv(0, false), encoding: 'utf8', timeout: 30_000 })
      pkg = { ok: out.status === 0, ...(parse(out.stdout, {}) || {}) }
    }
  }
  const run = (await lc(`/api/runs/${encodeURIComponent(id)}`)).body
  return { ...v.body, label: labelOf(run, r.requested_mode), identity: side.identity.label, package: pkg }
}

async function finalize(r: Row, run: any) {
  const label = labelOf(run, r.requested_mode), tagMode = label.startsWith('MIXED') ? 'MIXED' : label
  const verify = (await lc(`/api/runs/${r.id}/verify`)).body || { ok: false, errors: ['verify unavailable'] }
  const doc = await lc(`/api/runs/${r.id}/document`, { text: true })
  let manifest: any = null, contract = '', testsPy = ''
  if (Object.values(run.ledger || {}).some((v: any) => Array.isArray(v) && v.length)) {
    const ex = await lc(`/api/export/${r.id}`, { body: {} })
    if (ex.status === 200) {
      manifest = ex.body
      delete manifest.package // server path, not useful outside the box
      const folder = join(chainDataDir(), 'skills', manifest.id)
      try { contract = readFileSync(join(folder, 'CONTRACT.md'), 'utf8'); testsPy = readFileSync(join(folder, 'tests', 'test_acceptance.py'), 'utf8') } catch {}
    }
  }
  const src = { brief: `logic:${r.id}:brief`, run: `logic:${r.id}:run`, skill: `logic:${r.id}:skill` }
  const ids = { brief: libItemId('logic', src.brief), run: libItemId('logic', src.run), skill: manifest ? libItemId('logic', src.skill) : null }
  const common = { runId: r.id, mode: run.mode, label, status: run.status, signer: run.audit?.signer, head: verify.head, verified: !!verify.ok, links: { ...links(r.id), library: ids } }
  const title = clip(r.objective, 90)
  const tags = ['logic-chain', tagMode, run.status]
  upsertItem({ type: 'logic', sourceId: src.brief, userId: r.user_id, agentId: AGENT, title: `[${tagMode}] Brief · ${title}`, preview: clip(run.synthesis?.text || doc.text, 300),
    tags: [...tags, 'brief'], meta: { ...common, kind: 'brief' }, snapshot: { text: doc.status === 200 ? doc.text : String(run.synthesis?.text || ''), data: { runId: r.id, label, objective: r.objective, synthesis: run.synthesis } } })
  upsertItem({ type: 'logic', sourceId: src.run, userId: r.user_id, agentId: AGENT, title: `[${tagMode}] run.json (signed chain) · ${title}`,
    preview: `${run.audit?.records?.length || 0} signed records · signer ${run.audit?.signer || '?'} · verify ${verify.ok ? 'OK' : 'FAILED'}`,
    body: `${r.objective}\n${run.synthesis?.text || ''}`, tags: [...tags, 'run.json', verify.ok ? 'verified' : 'unverified'], meta: { ...common, kind: 'run.json', verify: { ok: verify.ok, records: verify.records, errors: verify.errors, warnings: verify.warnings } },
    snapshot: { text: `# Logic Chain run ${r.id} [${label}]\nObjective: ${r.objective}\nStatus: ${run.status}\nSigner: ${run.audit?.signer}\nChain head: ${verify.head}\nVerify: ${verify.ok ? 'OK' : 'FAILED ' + (verify.errors || []).join('; ')}`, data: run } })
  if (manifest) {
    upsertItem({ type: 'logic', sourceId: src.skill, userId: r.user_id, agentId: AGENT, title: `[${tagMode}] Skill package ${manifest.id} · ${title}`,
      preview: `${manifest.status} · ${manifest.logic?.length || 0} logic items · ${manifest.contract_tests_count ?? manifest.execution_contract?.acceptance_tests?.length ?? 0} acceptance tests · not executable`,
      body: `${r.objective}\n${contract}`, tags: [...tags, 'skill', manifest.status], meta: { ...common, kind: 'skill', skillId: manifest.id },
      snapshot: { text: contract || JSON.stringify(manifest, null, 2), data: { manifest, files: { 'CONTRACT.md': contract, 'tests/test_acceptance.py': testsPy } } } })
    db.prepare("insert into logic_skills(id,run_id,user_id,title,mode,label,manifest,agents,created_at) values(?,?,?,?,?,?,?,'[]',?) on conflict(id) do update set manifest=excluded.manifest,label=excluded.label")
      .run(manifest.id, r.id, r.user_id, title, run.mode, label, JSON.stringify(manifest), now())
  }
  db.prepare('update logic_runs set status=?,mode=?,label=?,signer=?,verified=?,lib=?,skill_id=?,error=?,updated_at=? where id=?')
    .run(run.status, run.mode || null, label, run.audit?.signer || null, verify.ok ? 1 : 0, JSON.stringify(ids), manifest?.id || null, run.stop_reason || null, now(), r.id)
  appendRecord('logic.run.done', { runId: r.id, status: run.status, label, verified: !!verify.ok, records: verify.records, head: verify.head, signer: run.audit?.signer, skill: manifest?.id || null, library: ids }, { userId: r.user_id, agentId: AGENT })
}

let polling: NodeJS.Timeout | null = null
const inFlight = new Set<string>()
function poll() {
  if (polling) return
  polling = setInterval(async () => {
    const open = db.prepare("select * from logic_runs where status in ('running','finalizing')").all() as Row[]
    if (!open.length) { clearInterval(polling!); polling = null; return }
    if (!side.ready) return
    for (const r of open) {
      if (inFlight.has(r.id)) continue
      inFlight.add(r.id)
      try {
        const res = await lc(`/api/runs/${r.id}`)
        if (res.status === 404) { db.prepare("update logic_runs set status='failed',error=?,updated_at=? where id=?").run('run missing from the Logic Chain data dir', now(), r.id); continue }
        const run = res.body
        if (!run?.id) continue
        if (FINISHED.includes(run.status)) {
          if (db.prepare("update logic_runs set status='finalizing' where id=? and status='running'").run(r.id).changes || r.status === 'finalizing') await finalize(r, run)
        } else db.prepare('update logic_runs set label=?,updated_at=? where id=?').run(labelOf(run, r.requested_mode), now(), r.id)
      } catch (e: any) {
        console.error('[logic-chain] poll', r.id, e?.message)
        db.prepare("update logic_runs set status='running' where id=? and status='finalizing'").run(r.id)
      } finally { inFlight.delete(r.id) }
    }
  }, int(process.env.LOGIC_CHAIN_POLL_MS, 1500, 100, 60_000))
  polling.unref()
}
async function waitDone(userId: string, id: string, ms: number) {
  const t = Date.now()
  while (Date.now() - t < ms) { const r = load(id, userId); if (r && !['running', 'finalizing'].includes(r.status)) return; await sleep(500) }
}

// ---------- skills: candidate packages, selectable per agent, enabled for none by default ----------
type SkillRow = { id: string; run_id: string; user_id: string; title: string; mode: string; label: string; manifest: string; agents: string; created_at: number }
const skillView = (s: SkillRow, full = false) => {
  const m = parse(s.manifest, {})
  return { id: s.id, runId: s.run_id, title: s.title, label: s.label, status: m.status, goal: clip(m.goal, 300), agents: parse(s.agents, []), executable: false, createdAt: s.created_at,
    signer: m.signature?.signer, ...(full ? { manifest: m } : {}) }
}
export const listSkills = (userId: string) => (db.prepare('select * from logic_skills where user_id=? order by created_at desc limit 200').all(userId) as SkillRow[]).map((s) => skillView(s))
export function setSkillAgents(userId: string, id: string, agents: any) {
  const s = db.prepare('select * from logic_skills where id=? and user_id=?').get(id, userId) as SkillRow | undefined
  if (!s) throw new HttpError(404, 'Not found')
  if (!Array.isArray(agents)) throw new HttpError(400, 'agents must be an array of agent ids')
  const known = new Set(loadManifests().map((a) => a.id))
  const bad = agents.filter((a) => !known.has(String(a)))
  if (bad.length) throw new HttpError(400, `unknown agent ids: ${bad.join(', ')}`)
  const list = [...new Set(agents.map(String))]
  db.prepare('update logic_skills set agents=? where id=?').run(JSON.stringify(list), id)
  appendRecord('logic.skill.agents', { skillId: id, agents: list }, { userId, agentId: AGENT })
  return skillView({ ...s, agents: JSON.stringify(list) })
}

// ---------- agent tools ----------
const tools: Tool[] = [
  {
    name: 'logic_chain_run', risk: 'approval',
    description: 'Run the FRAYMUS Logic Chain on an objective: eight model seats over two passes produce a signed (Ed25519, hash-linked) audit chain, a brief and a candidate skill package, all saved to the Library. mode "mock" (default) uses labelled demo fixtures (no network, no cost); mode "live" uses the server provider keys and spends up to the cost cap. Waits for the run (up to ~10 min) and returns its status, MOCK/LIVE label and brief.',
    parameters: { type: 'object', properties: { objective: { type: 'string', description: 'What to design or plan' }, mode: { type: 'string', enum: ['mock', 'live'] }, maxUsd: { type: 'number', description: 'Lower the per-run cost cap (live only)' } }, required: ['objective'] },
    async run(a, c) {
      const started = await createRun(c.userId, { objective: a.objective, mode: a.mode || 'mock', maxUsd: a.maxUsd, approveSpend: a.mode === 'live' }, c.agentId)
      await waitDone(c.userId, started.id, int(process.env.LOGIC_CHAIN_TOOL_WAIT_MS, 600_000, 1000, 3_600_000))
      return getRun(c.userId, started.id)
    }
  },
  {
    name: 'logic_chain_status', risk: 'safe',
    description: 'Status of a Logic Chain run (stages, MOCK/LIVE label, brief, Library links), or the recent runs when runId is omitted.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } } },
    async run(a, c) { return a.runId ? (await getRun(c.userId, String(a.runId))) || { error: 'run not found' } : { runs: listRuns(c.userId).slice(0, 10) } }
  },
  {
    name: 'logic_chain_verify', risk: 'safe',
    description: 'Verify a Logic Chain run: every signature, the hash links, the ledger replay, and the exported skill package hashes/signature. Returns ok, signer fx number, chain head and any errors.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
    async run(a, c) { return (await verifyRun(c.userId, String(a.runId))) || { error: 'run not found' } }
  },
  {
    name: 'logic_chain_skills', risk: 'safe',
    description: 'Logic Chain skill packages enabled for you (the calling agent). Without skillId lists them; with skillId returns the package (goal, logic, steps, acceptance tests). Packages are candidate specifications (status candidate_unverified), not executable code.',
    parameters: { type: 'object', properties: { skillId: { type: 'string' } } },
    async run(a, c) {
      const mine = (db.prepare('select * from logic_skills where user_id=? order by created_at desc').all(c.userId) as SkillRow[]).filter((s) => parse(s.agents, []).includes(c.agentId))
      if (!a.skillId) return { skills: mine.map((s) => skillView(s)), note: mine.length ? undefined : 'No Logic Chain skill is enabled for this agent. The owner enables one with POST /api/logic-chain/skills/:id/agents.' }
      const s = mine.find((x) => x.id === a.skillId)
      return s ? skillView(s, true) : { error: 'skill not found or not enabled for this agent' }
    }
  }
]

export function initLogicChain() {
  registerTools(tools)
  if (!enabled()) { side.error = 'disabled (LOGIC_CHAIN=off)'; return }
  process.once('exit', stopSidecar)
  startSidecar().then(() => { if (db.prepare("select 1 from logic_runs where status in ('running','finalizing') limit 1").get()) poll() })
    .catch((e) => { side.error = String(e?.message || e); console.error('[logic-chain]', side.error) })
}

export function status() {
  const k = providerKeys(), seats = liveSeats()
  return {
    enabled: enabled(), ready: side.ready, error: side.error || undefined, sidecar: side.external ? 'external (LOGIC_CHAIN_URL)' : 'child', listen: side.base ? side.base.replace(/^https?:\/\//, '') : undefined,
    python: side.python, vendored: { path: 'vendor/logic-chain', commit: LOGIC_CHAIN_COMMIT },
    identity: { source: side.identity.source, label: side.identity.label, error: side.identity.error },
    providers: { xai: k.xai ? { set: true, from: k.xai.from } : { set: false }, gemini: { set: !!k.gemini }, openai: k.openai ? { set: true, baseUrl: process.env.OPENAI_BASE_URL ? 'OPENAI_BASE_URL' : 'api.openai.com' } : { set: false } },
    liveSeats: seats.map((s) => `${s.provider}:${s.model}`), defaultMode: 'mock', liveAvailable: seats.length > 0, caps: caps(),
    log: side.ready ? undefined : side.log.slice(-5)
  }
}

// ---------- routes (behind the workspace gate like every /api/* route) ----------
export function registerLogicChainRoutes(app: FastifyInstance) {
  const uid = (req: any) => String(req.userId)
  const fail = (reply: any, e: any) => reply.status(e instanceof HttpError ? e.code : 500).send({ error: String(e?.message || e) })
  app.get('/api/logic-chain/status', async () => status())
  app.post('/api/logic-chain/runs', async (req, reply) => { try { return reply.status(202).send(await createRun(uid(req), req.body || {})) } catch (e) { return fail(reply, e) } })
  app.get('/api/logic-chain/runs', async (req) => ({ runs: listRuns(uid(req)) }))
  app.get('/api/logic-chain/runs/:id', async (req, reply) => {
    try { const r = await getRun(uid(req), (req.params as any).id, ['1', 'true'].includes(String((req.query as any)?.full))); return r || reply.status(404).send({ error: 'Not found' }) } catch (e) { return fail(reply, e) }
  })
  app.get('/api/logic-chain/runs/:id/verify', async (req, reply) => {
    try { const r = await verifyRun(uid(req), (req.params as any).id); return r || reply.status(404).send({ error: 'Not found' }) } catch (e) { return fail(reply, e) }
  })
  app.get('/api/logic-chain/runs/:id/document', async (req, reply) => {
    try {
      const id = (req.params as any).id
      if (!load(id, uid(req))) return reply.status(404).send({ error: 'Not found' })
      needReady()
      const d = await lc(`/api/runs/${encodeURIComponent(id)}/document`, { text: true })
      if (d.status !== 200) return reply.status(d.status).send({ error: 'document unavailable' })
      return reply.type('text/markdown; charset=utf-8').send(d.text)
    } catch (e) { return fail(reply, e) }
  })
  app.post('/api/logic-chain/runs/:id/cancel', async (req, reply) => {
    try {
      const id = (req.params as any).id
      if (!load(id, uid(req))) return reply.status(404).send({ error: 'Not found' })
      needReady()
      const r = await lc(`/api/runs/${encodeURIComponent(id)}/cancel`, { body: {} })
      return reply.status(r.status === 202 ? 202 : 409).send(r.status === 202 ? { id, cancelling: true } : { error: r.body?.error || 'Run is not active' })
    } catch (e) { return fail(reply, e) }
  })
  app.get('/api/logic-chain/skills', async (req) => ({ skills: listSkills(uid(req)) }))
  app.get('/api/logic-chain/skills/:id', async (req, reply) => {
    const s = db.prepare('select * from logic_skills where id=? and user_id=?').get((req.params as any).id, uid(req)) as SkillRow | undefined
    return s ? skillView(s, true) : reply.status(404).send({ error: 'Not found' })
  })
  app.post('/api/logic-chain/skills/:id/agents', async (req, reply) => { try { return setSkillAgents(uid(req), (req.params as any).id, (req.body as any)?.agents) } catch (e) { return fail(reply, e) } })
}
