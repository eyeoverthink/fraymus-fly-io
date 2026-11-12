// Fake-HTTP checks for the free-first image chain. No live provider calls.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const dir = mkdtempSync(join(tmpdir(), 'image-gen-'))
const originalDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dir

const KEYS = [
  'HF_TOKEN', 'HF_IMAGE_MODEL', 'HF_IMAGE_MODELS', 'IMAGE_PROVIDERS', 'BUYER_IMAGE_PROVIDERS',
  'IMAGE_GENERATION_TIMEOUT_MS', 'IMAGE_DOWNLOAD_MAX_BYTES', 'GEMINI_API_KEY', 'GEMINI_IMAGE_MODEL',
  'LOCAL_IMAGE_URL', 'LOCAL_IMAGE_ENDPOINT', 'LOCAL_IMAGE_KIND', 'LOCAL_IMAGE_TOKEN', 'COMFY_CHECKPOINT',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_IMAGE_MODEL', 'OPENAI_IMAGE_BASE_URL',
  'REPLICATE_API_TOKEN', 'REPLICATE_IMAGE_MODEL', 'ENABLE_PAID_REPLICATE', 'LLM_PROVIDERS'
]
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const resetEnv = () => { for (const k of KEYS) delete process.env[k] }

let failures = 0, passes = 0
const ok = (c: unknown, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }

const img = await import('../server/image-generation.ts')
const services = await import('../server/services.ts')
const pipeline = await import('../server/pipeline.ts')

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
let handler: (url: string, init: RequestInit | undefined) => Promise<Response> = async () => { throw new Error('no fetch') }
let inFlight = 0
let maxInFlight = 0
const warnings: string[] = []
const origWarn = console.warn
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

function installFetch() {
  calls = []; inFlight = 0; maxInFlight = 0
  img.setImageFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); calls.push({ url, init })
    try { return await handler(url, init) } finally { inFlight-- }
  })
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const png = (headers: Record<string, string> = {}) => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', ...headers } })
const urls = () => calls.map((c) => c.url)
const paid = () => urls().some((u) => /api\.openai\.com|api\.replicate\.com|fal-ai|nscale/.test(u))

resetEnv()
installFetch()
try {
  ok(img.listedImageProviders().join(',') === 'huggingface,gemini,pollinations,local', `default order (${img.listedImageProviders().join(',')})`)
  ok(img.imageProviderPlan().join(',') === 'pollinations', `with no keys only Pollinations runs (${img.imageProviderPlan().join(',')})`)
  ok(img.listedImageProviders({ strict: true }).join(',') === 'huggingface', `buyer list is huggingface (${img.listedImageProviders({ strict: true }).join(',')})`)
  process.env.OPENAI_API_KEY = 'sk-test-openai-key-0001'
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  process.env.HF_TOKEN = 'hf_testtokenvalue0001'
  ok(img.imageProviderPlan().join(',') === 'huggingface,pollinations', `paid keys stay out of the default plan (${img.imageProviderPlan().join(',')})`)
  ok(!img.imageProviderPlan().includes('openai') && !img.imageProviderPlan().includes('replicate'), 'openai and replicate are not active by default')
  process.env.IMAGE_PROVIDERS = 'openai,replicate'
  ok(img.imageProviderPlan().join(',') === 'openai,replicate', 'paid providers run only when listed and keyed')
  delete process.env.OPENAI_API_KEY
  delete process.env.REPLICATE_API_TOKEN
  ok(img.imageProviderPlan().join(',') === '', 'listed paid providers without keys are skipped')
  process.env.IMAGE_PROVIDERS = 'none'
  ok(img.listedImageProviders().length === 0, 'none selects nothing')

  // Hugging Face tries FLUX, then SDXL. No fal-ai, no OpenAI.
  resetEnv(); installFetch(); warnings.length = 0
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_testtokenvalue0001'
  process.env.IMAGE_PROVIDERS = 'huggingface'
  process.env.OPENAI_API_KEY = 'sk-test-openai-key-0001'
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  handler = async (url) => {
    if (url.includes('FLUX.1-schnell')) return json(503, { error: 'model loading' })
    if (url.includes('stable-diffusion-xl-base-1.0')) return png()
    throw new Error('unexpected ' + url)
  }
  const sdxl = await img.runFlux('hf fox')
  ok(sdxl.engine === 'huggingface' && sdxl.model.includes('stable-diffusion-xl') && sdxl.costMode === 'free' && sdxl.mocked === false, `SDXL after FLUX fails (${sdxl.model})`)
  ok(urls().length === 2 && urls().every((u) => u.includes('router.huggingface.co/hf-inference/models/')), `both calls are HF inference (${urls().join(' | ')})`)
  ok(!paid(), 'FLUX/SDXL path does not call fal-ai, nscale, OpenAI, or Replicate')

  // Fallback: HF and Gemini fail, Pollinations succeeds. Paid hosts are not called.
  resetEnv(); installFetch(); warnings.length = 0
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_testtokenvalue0001'
  process.env.GEMINI_API_KEY = 'AIzaTestGeminiKey0001234567890'
  process.env.OPENAI_API_KEY = 'sk-test-openai-key-0001'
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  handler = async (url) => {
    if (url.includes('router.huggingface.co')) return json(401, { error: 'unauthorized' })
    if (url.includes('generativelanguage.googleapis.com')) return json(429, { error: { message: 'quota exceeded' } })
    if (url.includes('image.pollinations.ai')) return png({ 'content-type': 'image/jpeg' })
    throw new Error('unexpected ' + url)
  }
  const fell = await img.runFlux('a red fox')
  ok(fell.engine === 'pollinations-classic' && fell.costMode === 'free' && fell.watermark === true, `falls through to Pollinations (${fell.engine})`)
  const hosts = urls().map((u) => new URL(u).host)
  ok(hosts.join(',') === 'router.huggingface.co,router.huggingface.co,generativelanguage.googleapis.com,image.pollinations.ai', `order ${hosts.join(',')}`)
  ok(!paid(), 'unlisted paid hosts are not called')
  const geminiCall = calls.find((c) => c.url.includes('generativelanguage'))!
  ok(!geminiCall.url.includes('AIza'), 'Gemini key stays out of the URL')
  ok((geminiCall.init?.headers as Record<string, string>)['x-goog-api-key']?.startsWith('AIza'), 'Gemini key is a header')
  ok(warnings.some((l) => l.includes('huggingface failed')) && warnings.some((l) => l.includes('quota exceeded')), 'failures are logged with a short reason')

  // Opt-in OpenAI workgroup error falls through and the key is not logged. Chat base URL is not the image host.
  resetEnv(); installFetch(); warnings.length = 0
  process.env.DATA_DIR = dir
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz'
  process.env.IMAGE_PROVIDERS = 'openai,pollinations'
  process.env.OPENAI_API_KEY = secret
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  handler = async (url) => {
    if (url.includes('api.openai.com')) return json(400, { error: { message: `organization workgroup mismatch for key ${secret}` } })
    if (url.includes('image.pollinations.ai')) return png()
    throw new Error('unexpected ' + url)
  }
  const org = await img.runFlux('a red fox')
  ok(org.engine === 'pollinations-classic', 'openai org error falls through')
  ok(urls()[0] === 'https://api.openai.com/v1/images/generations', `opted-in openai uses api.openai.com, not OPENAI_BASE_URL (${urls()[0]})`)
  const body = JSON.parse(String(calls[0].init?.body))
  ok(body.model === 'gpt-image-1' && body.prompt === 'a red fox', 'openai images request uses gpt-image-1')
  ok(!urls().some((u) => u.includes('api.x.ai')), 'image call does not follow the xAI chat base URL')
  const joined = warnings.join('\n')
  ok(joined.includes('workgroup') && !joined.includes(secret) && !joined.includes('sk-live'), 'workgroup failure is logged without the key')

  // Every provider that ran is named when all of them fail.
  img.resetImageGenForTests()
  resetEnv(); installFetch(); warnings.length = 0
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_shouldnotleaktoken0001'
  process.env.GEMINI_API_KEY = 'AIzaShouldNotLeak0001234567'
  handler = async (url) => {
    if (url.includes('router.huggingface.co')) return json(503, { error: 'model not found' })
    if (url.includes('generativelanguage')) return json(403, { error: { message: 'billing disabled for AIzaShouldNotLeak0001234567' } })
    if (url.includes('image.pollinations.ai')) return json(402, { error: 'rate limited' })
    throw new Error('unexpected ' + url)
  }
  let message = ''
  try { await img.runFlux('a red fox') } catch (e: any) { message = e.message }
  ok(message.startsWith('Image generation failed. Tried huggingface'), 'all-fail names huggingface: ' + message.slice(0, 80))
  ok(message.includes('gemini') && message.includes('pollinations'), 'all-fail names every provider that ran')
  ok(message.includes('model not found') && message.includes('rate limited'), 'all-fail keeps the short reasons')
  ok(!message.includes('hf_shouldnotleak') && !message.includes('AIzaShouldNotLeak'), 'error text omits keys')
  ok(!message.includes('openai') && !message.includes('replicate'), 'untried paid providers are not blamed')

  // Nothing configured: placeholder, no request. strict refuses it.
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'none'
  process.env.OPENAI_API_KEY = secret
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  handler = async () => { throw new Error('network') }
  const off = await img.runFlux('offline')
  ok(off.mocked === true && off.engine === 'offline-placeholder' && urls().length === 0, 'none returns a placeholder and makes no request')
  let strictErr = ''
  try { await img.runFlux('offline', { strict: true }) } catch (e: any) { strictErr = e.message }
  ok(/Image generation failed/.test(strictErr) && /refund/i.test(strictErr), `strict empty chain fails closed (${strictErr.slice(0, 100)})`)

  // Local Automatic1111, and a paid host is refused before any request.
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'local'
  process.env.LOCAL_IMAGE_URL = 'http://127.0.0.1:7860'
  handler = async (url, init) => {
    if (url.endsWith('/sdapi/v1/txt2img')) {
      const b = JSON.parse(String(init?.body))
      if (b.prompt !== 'local fox') return json(400, { error: 'bad prompt' })
      return json(200, { images: [PNG.toString('base64')] })
    }
    throw new Error('unexpected ' + url)
  }
  const local = await img.runFlux('local fox')
  ok(local.engine === 'local' && local.model === 'a1111' && urls().length === 1, 'local Automatic1111 is used when LOCAL_IMAGE_URL is set')
  img.resetImageGenForTests(); installFetch()
  process.env.LOCAL_IMAGE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = secret
  let localMsg = ''
  try { await img.runFlux('nope') } catch (e: any) { localMsg = e.message }
  ok(urls().length === 0 && localMsg.includes('local') && localMsg.includes('paid host'), `local refuses api.openai.com (${localMsg.slice(0, 120)})`)

  // Replicate image only when listed.
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'replicate'
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  handler = async (url) => {
    if (url.includes('api.replicate.com')) return json(201, { status: 'succeeded', output: 'https://cdn.example/out.png' })
    if (url === 'https://cdn.example/out.png') return png()
    throw new Error('unexpected ' + url)
  }
  const rep = await img.runFlux('rep fox')
  ok(rep.engine === 'replicate' && urls()[0].includes('/models/black-forest-labs/flux-schnell/predictions'), 'replicate image runs only when listed')

  // Upscale: token alone, flag alone, and list alone do not call Replicate.
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  process.env.ENABLE_PAID_REPLICATE = '1'
  handler = async () => { throw new Error('replicate must not be called') }
  const flagged = await services.runUpscaler(tiny, 2)
  ok(flagged.engine === 'sharp-lanczos3-resize' && flagged.kind === 'resize' && urls().length === 0, 'ENABLE_PAID_REPLICATE=1 without a listing does not call Replicate')
  process.env.IMAGE_PROVIDERS = 'replicate'
  process.env.ENABLE_PAID_REPLICATE = '0'
  const listedOnly = await services.runUpscaler(tiny, 2)
  ok(listedOnly.kind === 'resize' && urls().length === 0, 'listing replicate with the flag at 0 does not upscale on Replicate')
  process.env.ENABLE_PAID_REPLICATE = '1'
  installFetch()
  handler = async (url) => {
    if (url.includes('api.replicate.com')) return json(201, { status: 'succeeded', output: 'https://cdn.example/up.png' })
    if (url.includes('cdn.example/up.png')) return png()
    return new Response('no', { status: 500 })
  }
  const paidUp = await services.runUpscaler(tiny, 2)
  ok(paidUp.engine === 'replicate-real-esrgan' && paidUp.kind === 'ai-upscale' && urls().some((u) => u.includes('api.replicate.com')), 'upscale needs the list, the token, and ENABLE_PAID_REPLICATE=1')

  // Pollinations stays one-at-a-time and retries 402.
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'pollinations'
  let polls = 0
  handler = async (url) => {
    if (!url.includes('image.pollinations.ai')) return new Response('no', { status: 500 })
    polls++
    if (polls === 1) return new Response('slow down', { status: 402, headers: { 'retry-after': '0.05', 'content-type': 'application/json' } })
    return png()
  }
  const queuedA = img.runFlux('prompt-a')
  const queuedB = img.runFlux('prompt-b')
  const [a, b] = await Promise.all([queuedA, queuedB])
  ok(maxInFlight === 1, `one Pollinations request at a time (max ${maxInFlight})`)
  ok(a.engine === 'pollinations-classic' && b.engine === 'pollinations-classic' && polls >= 3, `402 then success (polls ${polls})`)

  // Strict pipeline does not keep a placeholder.
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'placeholder'
  const ran = await pipeline.runPipeline([{ id: 'gen', type: 'flux-schnell', data: {} }], [], { prompt: 'sneaker', strict: true })
  ok(ran.status === 'failed' && /Image generation failed|refund/i.test(ran.results.gen?.error || ''), `strict pipeline fails (${ran.results.gen?.error})`)
  ok(!ran.imageUrl, 'strict pipeline does not keep a placeholder image')

  // No fal-ai or nscale image route remains in the server.
  const files: string[] = []
  const walk = (d: string) => { for (const name of readdirSync(d)) { const p = join(d, name); if (name === 'node_modules' || name === 'dist' || name === 'vendor') continue; const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p) } }
  walk('server'); walk('src')
  const blob = files.map((p) => readFileSync(p, 'utf8')).join('\n')
  ok(!blob.includes('router.huggingface.co/fal-ai') && !blob.includes('/nscale/'), 'fal-ai and nscale image routes are gone')
  ok(blob.includes('https://api.openai.com/v1') && blob.includes('IMAGE_PROVIDERS'), 'OpenAI images exist only behind the provider list')
} catch (e: any) {
  console.error('THREW', e)
  failures++
} finally {
  console.warn = origWarn
  img.resetImageGenForTests()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
