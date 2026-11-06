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
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'HF_TOKEN', 'HF_FLUX_PROVIDER', 'HF_FLUX_MODEL', 'HF_FLUX_URL',
  'HF_IMAGE_ENABLED', 'IMAGE_PROVIDERS', 'BUYER_IMAGE_PROVIDERS', 'IMAGE_MONTHLY_CREDIT_CAP_USD',
  'HF_IMAGE_PRICE_PER_MEGAPIXEL_USD', 'IMAGE_ALLOW_PAID_OVERRUN', 'IMAGE_GENERATION_TIMEOUT_MS',
  'IMAGE_DOWNLOAD_MAX_BYTES', 'POLLINATIONS_MIN_INTERVAL_MS', 'GEMINI_API_KEY', 'GEMINI_IMAGE_MODEL',
  'GEMINI_IMAGE_INCLUDED_CREDIT_ONLY', 'GEMINI_IMAGE_BILLING_CONFIRMED', 'LOCAL_IMAGE_ENDPOINT', 'LOCAL_IMAGE_TOKEN',
  'REPLICATE_API_TOKEN', 'ENABLE_PAID_REPLICATE', 'REPLICATE_ESRGAN_VERSION'
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
const hfCalls = () => urls().filter((u) => u.includes('router.huggingface.co'))
const pollCalls = () => urls().filter((u) => u.includes('image.pollinations.ai'))

function falOk() {
  handler = async (url) => {
    if (url.includes('/nscale/')) throw new Error('nscale must not be called')
    if (url.includes('api.openai.com') || url.includes('api.replicate.com')) throw new Error('paid host ' + url)
    if (url.includes('/fal-ai/')) return json(200, { images: [{ url: 'https://cdn.example/out.png' }] })
    if (url.includes('cdn.example/out.png')) return png()
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
}

resetEnv()
installFetch()
try {
  process.env.HF_TOKEN = 'hf_test'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  const plan = img.imageProviderPlan()
  ok(plan.join(',') === 'hf-fal,pollinations,placeholder', `default chain (${plan.join(',')})`)
  ok(!plan.includes('nscale') && !plan.includes('openai') && !plan.includes('replicate'), 'default chain has no nscale and no paid provider')
  ok(img.imageProviderPlan({ strict: true }).join(',') === 'hf-fal', `buyer/strict default is hf-fal only (${img.imageProviderPlan({ strict: true }).join(',')})`)

  // 1 + 2. nscale never called; fal success is a real PNG with engine metadata
  img.resetImageGenForTests()
  installFetch()
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_test'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '1.50'
  falOk()
  const made = await img.runFlux('blue cup')
  const meta = await sharp(made.png).metadata()
  ok(made.engine === 'hf-fal' && made.model.includes('FLUX.1-schnell') && made.costMode === 'included-credit' && made.mocked === false && made.watermark === false, `fal success metadata (${made.engine}, ${made.costMode})`)
  ok(meta.format === 'png' && meta.width === 1 && meta.height === 1, `fal success normalized png ${meta.width}x${meta.height}`)
  ok(!urls().some((u) => u.includes('/nscale/')) && hfCalls().some((u) => u.includes('/fal-ai/')), 'default selection calls fal-ai and never nscale')
  ok(pollCalls().length === 0 && !urls().some((u) => /openai\.com|replicate\.com/.test(u)), 'fal success does not call Pollinations or a paid host')
  const logged = await img.imageCalls()
  ok(logged.some((r: any) => r.status === 'succeeded' && r.width === 1 && r.height === 1 && r.estimated_usd > 0), `usage row records estimate and dimensions (${JSON.stringify(logged)})`)

  // 3. billing/5xx skips HF once and uses Pollinations, never OpenAI
  for (const status of [401, 402, 403, 429, 500]) {
    img.resetImageGenForTests(); installFetch()
    process.env.DATA_DIR = dir
    process.env.HF_TOKEN = 'hf_test'
    process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
    process.env.IMAGE_PROVIDERS = 'hf-fal,pollinations,placeholder'
    handler = async (url) => {
      if (url.includes('router.huggingface.co')) return new Response('quota', { status })
      if (url.includes('image.pollinations.ai')) return png()
      if (/openai|replicate/.test(url)) throw new Error('paid ' + url)
      return new Response('no', { status: 500 })
    }
    const fell = await img.runFlux('cup ' + status)
    ok(fell.engine === 'pollinations-classic' && fell.costMode === 'free' && fell.watermark === true, `${status} falls through to Pollinations (${fell.engine})`)
    ok(hfCalls().length === 1 && !urls().some((u) => /openai\.com/.test(u)), `${status}: one HF call, no OpenAI, no billing retry`)
  }

  // 4. cap reservation blocks the next HF call; estimate and dimensions are stored
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_test'
  process.env.IMAGE_PROVIDERS = 'hf-fal,placeholder'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD = '0.003'
  process.env.IMAGE_MONTHLY_CREDIT_CAP_USD = '0.004'
  process.env.IMAGE_ALLOW_PAID_OVERRUN = 'false'
  falOk()
  const first = await img.runFlux('one')
  const hfBefore = hfCalls().length
  const second = await img.runFlux('two')
  ok(first.engine === 'hf-fal' && second.engine === 'offline-placeholder' && second.mocked === true, `cap: second image is the placeholder (${second.engine})`)
  ok(hfCalls().length === hfBefore, 'cap: no further HF request after the reservation is spent')
  const rows = await img.imageCalls()
  ok(rows.some((r: any) => r.status === 'succeeded' && r.width === 1 && r.height === 1) && rows.some((r: any) => r.status === 'cap-blocked'), `cap log has success dimensions and a blocked attempt (${rows.map((r: any) => r.status).join(',')})`)

  // parallel reservations: only one HF call fits
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  let hfInFlight = 0, hfMax = 0
  handler = async (url) => {
    if (url.includes('/fal-ai/')) {
      hfInFlight++; hfMax = Math.max(hfMax, hfInFlight)
      await new Promise((r) => setTimeout(r, 30))
      hfInFlight--
      return json(200, { images: [{ url: 'https://cdn.example/out.png' }] })
    }
    if (url.includes('cdn.example/out.png')) return png()
    return new Response('no', { status: 500 })
  }
  const pair = await Promise.all([img.runFlux('a'), img.runFlux('b')])
  ok(pair.filter((r) => r.engine === 'hf-fal').length === 1 && hfMax === 1, `atomic cap allows one in-flight HF call (engines ${pair.map((r) => r.engine).join(',')}, max ${hfMax})`)

  // 5. Pollinations 402 honors Retry-After, stays serial, then placeholder or hard failure by mode
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  delete process.env.HF_TOKEN
  process.env.IMAGE_PROVIDERS = 'pollinations,placeholder'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  let polls = 0
  const starts: number[] = []
  handler = async (url, init) => {
    if (!url.includes('image.pollinations.ai')) return new Response('no', { status: 500 })
    polls++
    starts.push(Date.now())
    if (!url.includes('safe=true') || !url.includes('width=768') || !url.includes('height=768')) return new Response('bad url', { status: 500 })
    const auth = JSON.stringify(init?.headers || {})
    if (/authorization|token|key=/i.test(url + auth)) return new Response('leaked', { status: 500 })
    if (polls === 1) return new Response('slow down', { status: 402, headers: { 'retry-after': '0.2' } })
    return png()
  }
  const queuedA = img.runFlux('prompt-a')
  const queuedB = img.runFlux('prompt-b')
  const [a, b] = await Promise.all([queuedA, queuedB])
  ok(maxInFlight === 1, `queue: one Pollinations request at a time (max ${maxInFlight})`)
  ok(a.engine === 'pollinations-classic' && b.engine === 'pollinations-classic', `402 then success (${a.engine}, ${b.engine})`)
  ok(polls >= 3, `402 was retried (poll fetches ${polls})`)
  const gap = starts.length >= 2 ? starts[1] - starts[0] : 0
  ok(gap >= 150, `Retry-After 0.2s was honored (${gap} ms)`)
  const pollsBeforeCache = polls
  const again = await img.runFlux('prompt-a')
  ok(again.watermark === true && again.attempts.some((x) => x.status === 'cache') && polls === pollsBeforeCache, 'repeat prompt is served from cache')

  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  handler = async () => new Response('no', { status: 402, headers: { 'retry-after': '0.01' } })
  const gaveUp = await img.runFlux('never')
  ok(gaveUp.mocked === true && gaveUp.engine === 'offline-placeholder' && gaveUp.costMode === 'offline', `exhausted Pollinations becomes the labelled placeholder (${gaveUp.engine})`)
  let strictErr = ''
  try { await img.runFlux('never', { strict: true }) } catch (e: any) { strictErr = e.message }
  ok(/refund|paid run stopped/i.test(strictErr), `strict mode fails instead of a placeholder (${strictErr.slice(0, 120)})`)

  // 6. invalid JSON, content type, oversized bytes
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_test'
  process.env.IMAGE_PROVIDERS = 'hf-fal,pollinations,placeholder'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  process.env.IMAGE_DOWNLOAD_MAX_BYTES = '100000'
  handler = async (url) => {
    if (url.includes('/fal-ai/')) return new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('no', { status: 500 })
  }
  const badJson = await img.runFlux('json')
  ok(badJson.engine === 'pollinations-classic' && badJson.attempts.some((x) => x.provider === 'hf-fal' && /invalid json/i.test(x.status)), 'invalid HF JSON is rejected and the chain continues')

  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  delete process.env.HF_TOKEN
  process.env.IMAGE_PROVIDERS = 'pollinations,placeholder'
  handler = async () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  const badType = await img.runFlux('html')
  ok(badType.engine === 'offline-placeholder' && badType.attempts.some((x) => /content-type/i.test(x.status)), `non-image content type rejected (${badType.attempts.map((x) => x.status).join('|')})`)

  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.IMAGE_DOWNLOAD_MAX_BYTES = '10'
  handler = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999999' } })
  const huge = await img.runFlux('huge')
  ok(huge.mocked === true && huge.attempts.some((x) => /too large/i.test(x.status)), 'oversized image is rejected')

  // 7. strict pipeline rejects a missing real provider and saves no image
  img.resetImageGenForTests(); installFetch()
  resetEnv()
  process.env.DATA_DIR = dir
  process.env.IMAGE_PROVIDERS = 'placeholder'
  const ran = await pipeline.runPipeline([{ id: 'gen', type: 'flux-schnell', data: {} }], [], { prompt: 'sneaker', strict: true })
  ok(ran.status === 'failed' && /paid run stopped|HF_TOKEN|no real image/i.test(ran.results.gen?.error || ''), `strict pipeline fails (${ran.results.gen?.error})`)
  ok(!ran.imageUrl && ran.results.gen?.mocked !== true, 'strict pipeline does not keep a placeholder image')

  // 8. agent tool reports engine and watermark
  const tools = await import('../server/agent/tools.ts')
  process.env.IMAGE_PROVIDERS = 'pollinations'
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  process.env.IMAGE_DOWNLOAD_MAX_BYTES = '100000'
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  handler = async (url) => url.includes('image.pollinations.ai') ? png() : new Response('no', { status: 500 })
  const tool = tools.getTool('generate_image')!
  const told = await tool.run({ prompt: 'cup' }, {} as any)
  ok(told.engine === 'pollinations-classic' && told.watermark === true && told.costMode === 'free' && typeof told.imageUrl === 'string', `agent tool reports engine and watermark (${told.engine}, watermark ${told.watermark})`)

  // 9. no OpenAI Images code path
  const files: string[] = []
  const walk = (d: string) => { for (const name of readdirSync(d)) { const p = join(d, name); if (name === 'node_modules' || name === 'dist' || name === 'vendor') continue; const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js|html)$/.test(name)) files.push(p) } }
  walk('server'); walk('src')
  const blob = files.map((p) => readFileSync(p, 'utf8')).join('\n')
  const openaiImage = /api\.openai\.com[^\n]{0,80}images|dall-e|dall_e|gpt-image/i.test(blob)
  const nscaleIsHf = blob.includes('router.huggingface.co/nscale/v1/images/generations')
  ok(!openaiImage && nscaleIsHf, 'no OpenAI Images call; the images/generations path is only the documented HF nscale route')

  // 10. Replicate token does not upscale unless ENABLE_PAID_REPLICATE=1
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  process.env.REPLICATE_API_TOKEN = 'r8_test'
  delete process.env.ENABLE_PAID_REPLICATE
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
  handler = async () => { throw new Error('replicate must not be called') }
  const resized = await services.runUpscaler(tiny, 2)
  ok(resized.engine === 'sharp-lanczos3-resize' && resized.kind === 'resize' && urls().length === 0, `default upscale is a Sharp resize (${resized.engine}, calls ${urls().length})`)
  process.env.ENABLE_PAID_REPLICATE = '1'
  installFetch()
  handler = async (url) => {
    if (url.includes('api.replicate.com')) return json(201, { status: 'succeeded', output: 'https://cdn.example/up.png' })
    if (url.includes('cdn.example/up.png')) return png()
    return new Response('no', { status: 500 })
  }
  const paid = await services.runUpscaler(tiny, 2)
  ok(paid.engine === 'replicate-real-esrgan' && paid.kind === 'ai-upscale' && urls().some((u) => u.includes('api.replicate.com')), 'ENABLE_PAID_REPLICATE=1 is required before Replicate is called')

  // Local worker: private bridge only. Offline stays offline. No public or paid fallback.
  img.resetImageGenForTests(); installFetch()
  process.env.DATA_DIR = dir
  delete process.env.LOCAL_IMAGE_ENDPOINT
  delete process.env.LOCAL_IMAGE_TOKEN
  handler = async () => { throw new Error('should not be called') }
  const absent = await img.fetchLocalImage('a warm room', 32, 48)
  ok('offline' in absent && absent.offline === true && urls().length === 0, 'unset local worker makes no request')
  process.env.LOCAL_IMAGE_ENDPOINT = 'http://127.0.0.1:8188/fraymus/generate'
  process.env.LOCAL_IMAGE_TOKEN = 'secret-token'
  installFetch()
  handler = async (url, init) => {
    if (/openai|replicate|pollinations|huggingface/i.test(url)) throw new Error('wrong host ' + url)
    const headers = init?.headers as Record<string, string> | undefined
    if (headers?.Authorization !== 'Bearer secret-token') return new Response('no', { status: 401 })
    const body = JSON.parse(String(init?.body || '{}'))
    if (body.width !== 32 || body.height !== 48) return new Response('size', { status: 400 })
    return png()
  }
  const bridged = await img.fetchLocalImage('a warm room', 32, 48)
  ok(!('offline' in bridged) && bridged.png.length > 8 && urls().length === 1, 'local worker returns only the private bridge image')
  installFetch()
  handler = async () => new Response('down', { status: 503 })
  const down = await img.fetchLocalImage('a warm room', 32, 48)
  ok('offline' in down && down.offline === true && urls().every((u) => u.includes('127.0.0.1:8188')), 'an offline worker is not replaced by a public or paid image API')
} catch (e: any) {
  console.error('THREW', e)
  failures++
} finally {
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
