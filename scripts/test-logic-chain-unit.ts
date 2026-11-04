// Unit checks for server/logic-chain config: provider-key resolution from env names only, seat/slot building,
// spend caps, the MOCK/MIXED/LIVE label, the identity fallback, and the sidecar env allow-list. No network, no sidecar.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lc-unit-'))
process.env.DATA_DIR = dir
let failures = 0, passes = 0
const ok = (c: any, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }
const KEYS = ['XAI_API_KEY', 'PROMPT_LLM_API_KEY', 'PROMPT_LLM_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'GEMINI_API_KEY', 'LOGIC_CHAIN_PROVIDERS', 'LOGIC_CHAIN_MAX_RUN_CENTS', 'LOGIC_CHAIN_MAX_PLAN_CALLS', 'LOGIC_CHAIN_MAX_SECONDS', 'FRAYMUS_IDENTITY_FILE', 'FRAYMUS_IDENTITY_SEED', 'LOGIC_CHAIN_XAI_MODEL', 'LOGIC_CHAIN_GEMINI_MODEL', 'LOGIC_CHAIN_OPENAI_MODEL']
const reset = () => { for (const k of KEYS) delete process.env[k] }
reset()

const lc = await import('../server/logic-chain/index.ts')
try {
  // caps
  ok(JSON.stringify(lc.caps()) === JSON.stringify({ maxRunCents: 100, maxPlanCalls: 60, maxElapsedSeconds: 3600 }), 'caps: defaults $1.00, 60 calls, 1 h')
  process.env.LOGIC_CHAIN_MAX_RUN_CENTS = '250'; process.env.LOGIC_CHAIN_MAX_PLAN_CALLS = 'lots'
  ok(lc.caps().maxRunCents === 250 && lc.caps().maxPlanCalls === 60, 'caps: env override, junk falls back to the default')
  reset()

  // mock config
  const m = lc.chainConfig('mock')
  ok(m.slots.length === 8 && m.slots.every((s: any) => s.kind === 'demo') && m.allow_remote === false && m.passes === 2, 'config: mock = 8 demo slots, no remote, 2 passes')
  ok(m.max_run_cents === 100 && m.max_plan_calls === 60, 'config: caps passed to the chain')

  // provider keys
  ok(lc.liveSeats().length === 0, 'seats: none with no keys')
  process.env.PROMPT_LLM_API_KEY = 'k-prompt'; process.env.PROMPT_LLM_BASE_URL = 'https://api.openai.com/v1'
  ok(lc.liveSeats().length === 0, 'seats: PROMPT_LLM_API_KEY is not used as an xAI key when its base URL is not x.ai')
  process.env.PROMPT_LLM_BASE_URL = 'https://api.x.ai/v1'
  ok(lc.liveSeats().map((s) => s.provider).join() === 'xai' && lc.sidecarEnv(1).XAI_API_KEY === 'k-prompt', 'seats: PROMPT_LLM_API_KEY reused for xAI when PROMPT_LLM_BASE_URL is api.x.ai (fly.toml)')
  process.env.XAI_API_KEY = 'k-xai'
  ok(lc.sidecarEnv(1).XAI_API_KEY === 'k-xai', 'seats: XAI_API_KEY wins over PROMPT_LLM_API_KEY')
  process.env.GEMINI_API_KEY = 'k-gem'; process.env.OPENAI_API_KEY = 'k-oa'
  const seats = lc.liveSeats()
  ok(seats.map((s) => `${s.provider}:${s.model}`).join() === 'xai:grok-4.3,gemini:gemini-3.5-flash-lite,openai:gpt-4.1-mini', `seats: default models (${seats.map((s) => s.model).join(', ')})`)
  ok(seats.find((s) => s.provider === 'openai')?.kind === 'openai', 'seats: OpenAI direct without OPENAI_BASE_URL')
  process.env.OPENAI_BASE_URL = 'https://router.example/v1/'
  const oa = lc.liveSeats().find((s) => s.provider === 'openai')!
  ok(oa.kind === 'openai_compatible' && oa.url === 'https://router.example/v1/chat/completions' && oa.key_env === 'OPENAI_API_KEY', 'seats: OPENAI_BASE_URL makes the OpenAI seat openai_compatible on that router')
  process.env.LOGIC_CHAIN_PROVIDERS = 'gemini'
  ok(lc.liveSeats().map((s) => s.provider).join() === 'gemini', 'seats: LOGIC_CHAIN_PROVIDERS narrows the providers')
  delete process.env.LOGIC_CHAIN_PROVIDERS
  const live = lc.chainConfig('live')
  ok(live.allow_remote === true && live.slots.every((s: any) => s.kind !== 'demo' && !('provider' in s) && !['k-xai', 'k-gem', 'k-oa', 'k-prompt'].some((v) => Object.values(s).includes(v))), 'config: live slots carry key env NAMES, never key values')
  ok(live.slots[7].key_env === 'XAI_API_KEY', 'config: the Integrator (writes the brief) gets the first provider')
  ok(new Set(live.slots.map((s: any) => s.key_env)).size === 3, 'config: all three providers seated')

  // sidecar env allow-list
  process.env.WORKSPACE_ACCESS_TOKEN = 'ws-secret'; process.env.SHOPIFY_ACCESS_TOKEN = 'shop-secret'; process.env.RESEND_API_KEY = 're-secret'
  const env = lc.sidecarEnv(1234)
  const leaked = Object.values(env).some((v) => ['ws-secret', 'shop-secret', 're-secret'].includes(v))
  ok(!leaked && env.FRAYMUS_HOST === '127.0.0.1' && env.FRAYMUS_PORT === '1234' && env.FRAYMUS_DATA_DIR === join(dir, 'logic-chain'), 'env: sidecar gets loopback host + its data dir, and no unrelated secret')
  ok(!('XAI_API_KEY' in lc.sidecarEnv(0, false)), 'env: the verify CLI runs without provider keys')
  reset()

  // labels
  ok(lc.labelOf({ mode: 'mock', stages: [{ kind: 'demo' }] }) === 'MOCK', 'label: mock run -> MOCK')
  ok(lc.labelOf({ stages: [{ kind: 'demo' }, { kind: 'demo' }] }) === 'MOCK', 'label: all-demo stages -> MOCK even without a mode')
  ok(lc.labelOf({ mode: 'mixed', stages: [{ kind: 'demo' }, { kind: 'gemini' }] }) === 'MIXED (part MOCK)', 'label: mixed -> MIXED (part MOCK)')
  ok(lc.labelOf({ mode: 'real', stages: [{ kind: 'demo' }, { kind: 'gemini' }] }) === 'MIXED (part MOCK)', 'label: any demo stage can never be LIVE')
  ok(lc.labelOf({ mode: 'real', stages: [{ kind: 'gemini' }, { kind: 'openai' }] }) === 'LIVE', 'label: all real providers -> LIVE')
  ok(lc.labelOf({}, 'mock') === 'MOCK' && lc.labelOf({}, 'live') === 'PENDING', 'label: before stages -> MOCK or PENDING, never LIVE')

  // identity
  ok(lc.resolveIdentity().source === 'local' && /LOCAL KEY/.test(lc.resolveIdentity().label), 'identity: none set -> labelled LOCAL KEY')
  process.env.FRAYMUS_IDENTITY_FILE = join(dir, 'missing.seed')
  const missing = lc.resolveIdentity()
  ok(missing.error && !existsSync(join(dir, 'missing.seed')), 'identity: missing FRAYMUS_IDENTITY_FILE is refused, no new key is made there')
  writeFileSync(join(dir, 'id.seed'), 'ab'.repeat(32)); process.env.FRAYMUS_IDENTITY_FILE = join(dir, 'id.seed')
  ok(lc.resolveIdentity().file === join(dir, 'id.seed') && !lc.resolveIdentity().error, 'identity: existing FRAYMUS_IDENTITY_FILE used')
  reset(); process.env.FRAYMUS_IDENTITY_SEED = 'nothex'
  ok(lc.resolveIdentity().error, 'identity: malformed FRAYMUS_IDENTITY_SEED refused')
  process.env.FRAYMUS_IDENTITY_SEED = 'cd'.repeat(32)
  const s = lc.resolveIdentity()
  ok(s.file && readFileSync(s.file, 'utf8').trim() === 'cd'.repeat(32) && (statSync(s.file).mode & 0o077) === 0 && !s.file.startsWith(dir), 'identity: FRAYMUS_IDENTITY_SEED written 0600 to a private temp dir, not the data volume')
  reset()
} catch (e) { console.error(e); failures++ }
lc.stopSidecar()
try { rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
