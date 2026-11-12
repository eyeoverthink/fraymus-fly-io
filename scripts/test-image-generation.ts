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
  'IMAGE_MONTHLY_CREDIT_CAP_USD', 'IMAGE_ALLOW_PAID_OVERRUN', 'HF_IMAGE_PRICE_PER_MEGAPIXEL_USD', 'HF_FLUX_MODEL', 'HF_FLUX_PROVIDER',
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
const paid = () => urls().some((u) => /api\.openai\.com|api\.replicate\.com|nscale/.test(u))

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

  // Hugging Face FLUX goes through the router fal-ai path, not hf-inference.
  img.resetImageGenForTests()
  resetEnv(); installFetch(); warnings.length = 0
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_testtokenvalue0001'
  process.env.IMAGE_PROVIDERS = 'huggingface'
  process.env.OPENAI_API_KEY = 'sk-test-openai-key-0001'
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  process.env.REPLICATE_API_TOKEN = 'r8_testreplicatetoken0001'
  handler = async (url, init) => {
    if (url.includes('hf-inference')) throw new Error('hf-inference must not be called')
    if (url.includes('api.openai.com') || url.includes('api.replicate.com') || url.includes('nscale')) throw new Error('paid host ' + url)
    if (url === 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell') {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
      if (!auth.includes('hf_testtokenvalue0001')) return json(401, { error: 'missing token' })
      const body = JSON.parse(String(init?.body))
      if (body.prompt !== 'hf fox' || body.num_inference_steps !== 4) return json(400, { error: 'bad body' })
      return json(200, { images: [{ url: 'https://cdn.example/flux.png' }] })
    }
    if (url === 'https://cdn.example/flux.png') return png()
    throw new Error('unexpected ' + url)
  }
  const flux = await img.runFlux('hf fox')
  ok(flux.engine === 'hf-fal' && flux.model.includes('FLUX.1-schnell') && flux.costMode === 'included-credit' && flux.mocked === false, `fal FLUX metadata (${flux.engine}, ${flux.model}, ${flux.costMode})`)
  ok(urls().filter((u) => u.includes('router.huggingface.co')).length === 1, `one HF router call (${urls().join(' | ')})`)
  ok(!urls().some((u) => u.includes('hf-inference') || u.includes('nscale') || u.includes('api.openai.com')), 'no hf-inference, nscale, or OpenAI')

  // Fallback: HF and Gemini fail, Pollinations succeeds. OpenAI and Replicate are not called.
  img.resetImageGenForTests()
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
  ok(hosts.join(',') === 'router.huggingface.co,generativelanguage.googleapis.com,image.pollinations.ai', `order ${hosts.join(',')}`)
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

  // Cap stops another fal-ai call and preview falls through to Pollinations. Buyer strict refunds.
  img.resetImageGenForTests()
  resetEnv(); installFetch()
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_testtokenvalue0001'
  process.env.GEMINI_API_KEY = 'AIzaTestGeminiKey0001234567890'
  process.env.IMAGE_PROVIDERS = 'huggingface,gemini,pollinations'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '0.004'
  process.env.IMAGE_ALLOW_PAID_OVERRUN = 'false'
  process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD = '0.003'
  handler = async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) throw new Error('gemini must not run after the cap')
    if (url.includes('/fal-ai/')) return json(200, { images: [{ url: 'https://cdn.example/flux.png' }] })
    if (url === 'https://cdn.example/flux.png') return png()
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('no', { status: 500 })
  }
  const first = await img.runFlux('one')
  const falBefore = urls().filter((u) => u.includes('/fal-ai/')).length
  const second = await img.runFlux('two')
  ok(first.engine === 'hf-fal' && second.engine === 'pollinations-classic' && second.watermark === true, `cap falls through to Pollinations (${second.engine})`)
  ok(urls().filter((u) => u.includes('/fal-ai/')).length === falBefore, 'cap: no further fal-ai request')
  ok(!urls().some((u) => u.includes('generativelanguage')), 'cap does not continue to Gemini')
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'huggingface'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '0.001'
  let capErr = ''
  try { await img.runFlux('buyer', { strict: true }) } catch (e: any) { capErr = e.message }
  ok(/cap-exceeded/.test(capErr) && /refund/i.test(capErr) && urls().every((u) => !u.includes('/fal-ai/')), `strict cap refunds without calling fal (${capErr.slice(0, 120)})`)

  // HF 402 exhausts the included credits and the next preview does not call fal again.
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '1.50'
  process.env.IMAGE_PROVIDERS = 'huggingface,pollinations'
  let falHits = 0
  handler = async (url) => {
    if (url.includes('/fal-ai/')) { falHits++; return json(402, { error: 'credits exhausted' }) }
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('no', { status: 500 })
  }
  const billed = await img.runFlux('bill')
  const after402 = falHits
  const again = await img.runFlux('bill-2')
  ok(billed.engine === 'pollinations-classic' && again.engine === 'pollinations-classic' && after402 === 1 && falHits === 1, `402 stops further HF calls (fal hits ${falHits})`)

  // A zero price must not turn the cap off. A billed generation whose file fails still counts.
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'huggingface,pollinations'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '0.001'
  process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD = '0'
  delete process.env.GEMINI_API_KEY
  handler = async (url) => {
    if (url.includes('/fal-ai/')) throw new Error('price zero must not call fal')
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('no', { status: 500 })
  }
  const zeroPrice = await img.runFlux('zero')
  ok(zeroPrice.engine === 'pollinations-classic' && urls().length === 1 && urls()[0].includes('pollinations'), 'non-positive price still uses the default estimate')

  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '0.004'
  process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD = '0.003'
  process.env.HF_FLUX_MODEL = 'black-forest-labs/FLUX.1-dev'
  process.env.HF_IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell'
  let devCalls = 0
  handler = async (url) => {
    if (url.includes('/flux/dev')) { devCalls++; return json(200, { images: [{ url: 'https://cdn.example/flux.png' }] }) }
    if (url.includes('/flux/schnell')) return json(200, { images: [{ url: 'https://cdn.example/flux.png' }] })
    if (url === 'https://cdn.example/flux.png') return new Response('missing', { status: 404 })
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('no', { status: 500 })
  }
  const lost = await img.runFlux('lost-file')
  const lostFal = urls().filter((u) => u.includes('/fal-ai/')).length
  const lostAgain = await img.runFlux('lost-file-2')
  ok(lost.engine === 'pollinations-classic' && lostAgain.engine === 'pollinations-classic' && devCalls === 0 && lostFal === 1, `HF_IMAGE_MODEL wins, and a billed download failure still spends the cap (fal ${lostFal})`)
  delete process.env.HF_FLUX_MODEL
  delete process.env.HF_IMAGE_MODEL

  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'huggingface'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '1.50'
  handler = async (url) => {
    if (url.includes('/fal-ai/')) return json(200, { images: [{ url: 'https://127.0.0.1/secret.png' }] })
    if (url.includes('127.0.0.1')) throw new Error('ssrf')
    return new Response('no', { status: 500 })
  }
  let privateMsg = ''
  try { await img.runFlux('private') } catch (e: any) { privateMsg = e.message }
  ok(/image url rejected/.test(privateMsg) && !urls().some((u) => u.includes('127.0.0.1')), `router image URL cannot target a private host (${privateMsg.slice(0, 100)})`)

  // No nscale image route. fal-ai is the HF router path.
  const files: string[] = []
  const walk = (d: string) => { for (const name of readdirSync(d)) { const p = join(d, name); if (name === 'node_modules' || name === 'dist' || name === 'vendor') continue; const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p) } }
  walk('server'); walk('src')
  const blob = files.map((p) => readFileSync(p, 'utf8')).join('\n')
  ok(blob.includes('router.huggingface.co/fal-ai/') && !blob.includes('/nscale/') && !blob.includes('hf-inference/models/'), 'fal-ai router is the HF path; nscale and hf-inference are not')
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
