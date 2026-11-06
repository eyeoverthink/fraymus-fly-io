// Free-first image generation: provider order, deprecated-model skip, monthly cap,
// paid-route opt-in, and the Pollinations one-at-a-time queue. No network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const dir = mkdtempSync(join(tmpdir(), 'image-gen-'))
const originalDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dir

const KEYS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'HF_TOKEN', 'HF_FLUX_PROVIDER', 'HF_FLUX_MODEL', 'HF_FLUX_URL', 'HF_FLUX_MONTHLY_CAP',
  'POLLINATIONS', 'POLLINATIONS_MIN_INTERVAL_MS', 'COMFYUI_URL', 'COMFYUI_CHECKPOINT',
  'IMAGE_PROVIDER', 'IMAGE_OPENAI', 'IMAGE_REPLICATE', 'OPENAI_API_KEY', 'OPENAI_IMAGE_MODEL', 'OPENAI_BASE_URL',
  'REPLICATE_API_TOKEN', 'REPLICATE_UPSCALE', 'REPLICATE_ESRGAN_VERSION', 'REQUIRE_AI_UPSCALE'
]
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const resetEnv = () => { for (const k of KEYS) delete process.env[k] }

let failures = 0, passes = 0
const ok = (c: unknown, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }

const img = await import('../server/image-gen.ts')
const services = await import('../server/services.ts')
const pipeline = await import('../server/pipeline.ts')

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
let handler: (url: string, init: RequestInit | undefined) => Promise<Response> = async () => { throw new Error('no fetch handler') }
let inFlight = 0
let maxInFlight = 0

function installFetch() {
  calls = []
  inFlight = 0
  maxInFlight = 0
  img.setImageFetchForTests(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    calls.push({ url, init })
    try { return await handler(url, init) }
    finally { inFlight-- }
  })
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
const urls = () => calls.map((c) => c.url)
const hfCalls = () => urls().filter((u) => u.includes('router.huggingface.co'))
const pollCalls = () => urls().filter((u) => u.includes('image.pollinations.ai'))

function routeFalThenImage() {
  handler = async (url) => {
    if (url.includes('/fal-ai/')) return json(200, { images: [{ url: 'https://cdn.example/out.png' }] })
    if (url.includes('cdn.example/out.png')) return png()
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
}

resetEnv()
installFetch()
try {
  // --- provider ordering (no nscale in the default) ---
  process.env.HF_TOKEN = 'hf_test'
  const normal = img.planImageRoutes()
  ok(normal[0] === 'hf-fal-ai' && normal.includes('pollinations') && normal[normal.length - 1] === 'placeholder', `order: HF fal-ai, then Pollinations, then placeholder (${normal.join(',')})`)
  ok(!normal.some((r: string) => r.includes('nscale')), 'order: nscale is not a default')
  ok(!normal.includes('openai') && !normal.includes('replicate'), 'order: OpenAI and Replicate are not in the free chain')

  process.env.HF_FLUX_PROVIDER = 'nscale,fal-ai'
  const explicit = img.planImageRoutes()
  ok(explicit[0] === 'hf-nscale' && explicit[1] === 'hf-fal-ai', `order: an explicit list may still name nscale first (${explicit.join(',')})`)
  delete process.env.HF_FLUX_PROVIDER

  delete process.env.HF_TOKEN
  const noToken = img.planImageRoutes()
  ok(noToken[0] === 'pollinations' && noToken.includes('placeholder') && !noToken.some((r: string) => r.startsWith('hf-')), `order: no HF token skips Hugging Face (${noToken.join(',')})`)

  process.env.HF_TOKEN = 'hf_test'
  process.env.COMFYUI_URL = 'http://127.0.0.1:8188'
  const withComfy = img.planImageRoutes()
  ok(withComfy.includes('comfyui') && withComfy.indexOf('comfyui') > withComfy.indexOf('pollinations') && withComfy.indexOf('placeholder') > withComfy.indexOf('comfyui'), 'order: local ComfyUI sits before the placeholder')
  const strictComfy = img.planImageRoutes(process.env, { strict: true })
  ok(strictComfy.includes('hf-fal-ai') && strictComfy.includes('comfyui') && !strictComfy.includes('pollinations') && !strictComfy.includes('placeholder'), `strict: included HF and local ComfyUI only (${strictComfy.join(',')})`)
  delete process.env.COMFYUI_URL
  const strictOnly = img.planImageRoutes(process.env, { strict: true })
  ok(strictOnly.join(',') === 'hf-fal-ai', `strict: HF only when that is the included route (${strictOnly.join(',')})`)
  delete process.env.HF_TOKEN
  ok(img.planImageRoutes(process.env, { strict: true }).length === 0, 'strict: nothing configured means no silent fallback route')

  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.REPLICATE_API_TOKEN = 'r8_test'
  process.env.HF_TOKEN = 'hf_test'
  const keysPresent = img.planImageRoutes()
  ok(!keysPresent.includes('openai') && !keysPresent.includes('replicate'), 'opt-in: API keys alone do not add paid image routes')
  process.env.IMAGE_OPENAI = '1'
  process.env.IMAGE_REPLICATE = '1'
  ok(!img.planImageRoutes().includes('openai') && !img.planImageRoutes().includes('replicate'), 'opt-in: flags without IMAGE_PROVIDER stay off the automatic chain')
  process.env.IMAGE_PROVIDER = 'openai'
  ok(img.planImageRoutes().join(',') === 'openai', 'opt-in: IMAGE_PROVIDER=openai and IMAGE_OPENAI=1 selects OpenAI')
  ok(img.planImageRoutes(process.env, { strict: true }).length === 0, 'opt-in: a paid provider is never a strict/buyer route')
  process.env.IMAGE_OPENAI = '0'
  ok(img.planImageRoutes().length === 0, 'opt-in: IMAGE_PROVIDER=openai with the flag off selects nothing')
  delete process.env.IMAGE_PROVIDER
  delete process.env.IMAGE_OPENAI

  process.env.HF_FLUX_MONTHLY_CAP = '2'
  ok(!img.planImageRoutes(process.env, { hfUsed: 2 }).some((r: string) => r.startsWith('hf-')), 'cap: a full month drops Hugging Face from the chain')
  ok(img.planImageRoutes(process.env, { hfUsed: 1 })[0] === 'hf-fal-ai', 'cap: under the cap, Hugging Face stays first')

  // --- 410 skip ---
  resetEnv()
  img.resetImageGenForTests()
  installFetch()
  process.env.DATA_DIR = dir
  process.env.HF_TOKEN = 'hf_test'
  process.env.HF_FLUX_PROVIDER = 'nscale,fal-ai'
  process.env.POLLINATIONS = 'off'
  process.env.HF_FLUX_MONTHLY_CAP = '5'
  handler = async (url) => {
    if (url.includes('/nscale/')) return new Response('{"error":"model deprecated"}', { status: 410, headers: { 'content-type': 'application/json' } })
    if (url.includes('/fal-ai/')) return json(200, { images: [{ url: 'https://cdn.example/out.png' }] })
    if (url.includes('cdn.example/out.png')) return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
  const skipped = await img.runFlux('a red fox')
  ok(skipped.provider === 'hf-fal-ai' && skipped.mocked === false && skipped.paid === false && skipped.included === true, `410: nscale is skipped and fal-ai wins (${skipped.provider})`)
  ok(hfCalls().some((u) => u.includes('/nscale/')) && hfCalls().some((u) => u.includes('/fal-ai/')), '410: both HF providers were attempted')
  ok(pollCalls().length === 0, '410: Pollinations is not called once fal-ai succeeds')
  ok(img.hfMonthlyCount() === 1, `410: a deprecated response does not consume the monthly cap (count ${img.hfMonthlyCount()})`)
  ok(!String(skipped.note || '').match(/organization/i), '410: no organization-verification wording on the HF result')

  // fal-ai itself deprecated -> free anonymous fallback, watermark disclosed
  img.resetImageGenForTests()
  installFetch()
  process.env.HF_FLUX_PROVIDER = 'fal-ai'
  delete process.env.POLLINATIONS
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '0'
  handler = async (url) => {
    if (url.includes('router.huggingface.co')) return new Response('model deprecated', { status: 410 })
    if (url.includes('image.pollinations.ai')) return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
  const water = await img.runFlux('a blue mug')
  ok(water.provider === 'pollinations' && water.watermark === true && /watermark/i.test(water.note), `410: fal-ai skip lands on Pollinations with a watermark note (${water.provider})`)
  const pollReq = calls.find((c) => c.url.includes('image.pollinations.ai'))
  ok(!!pollReq && !pollReq.url.includes('nologo=true') && !(pollReq.init?.headers && JSON.stringify(pollReq.init.headers).match(/authorization/i)), 'Pollinations: anonymous, watermark left on, no API key')

  // strict does not degrade after a 410
  img.resetImageGenForTests()
  installFetch()
  let strictErr = ''
  try { await img.runFlux('a blue mug', { strict: true }) } catch (e: any) { strictErr = e.message }
  ok(/refund|not falling back|paid run stopped/i.test(strictErr) && !/pollinations/i.test(urls().join(' ')), `strict 410: fails closed (${strictErr.slice(0, 140)})`)
  ok(!/organization must be verified/i.test(strictErr), 'strict 410: does not mention an OpenAI organization check')

  // --- cap enforcement ---
  img.resetImageGenForTests()
  installFetch()
  process.env.HF_FLUX_MONTHLY_CAP = '1'
  process.env.POLLINATIONS = 'off'
  routeFalThenImage()
  const first = await img.runFlux('one')
  const before = urls().length
  const second = await img.runFlux('two')
  ok(first.provider === 'hf-fal-ai' && img.hfMonthlyCount() === 1, 'cap: first success counts')
  ok(second.provider === 'placeholder' && second.mocked === true && /OFFLINE PLACEHOLDER/.test(second.note), `cap: the next image is the offline placeholder (${second.provider})`)
  ok(urls().length === before, 'cap: Hugging Face is not called once the month is full')
  let capErr = ''
  try { await img.runFlux('three', { strict: true }) } catch (e: any) { capErr = e.message }
  ok(/cap/i.test(capErr) && /refund|not falling back|paid run stopped/i.test(capErr), `cap: a paid run stops instead of degrading (${capErr.slice(0, 140)})`)

  // --- opt-in gating for paid generation ---
  img.resetImageGenForTests()
  installFetch()
  resetEnv()
  process.env.DATA_DIR = dir
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.REPLICATE_API_TOKEN = 'r8_test'
  process.env.POLLINATIONS = 'off'
  handler = async (url) => {
    if (url.includes('api.openai.com') || url.includes('api.replicate.com')) return json(200, { data: [{ b64_json: PNG.toString('base64') }] })
    return new Response('unexpected ' + url, { status: 500 })
  }
  const gated = await img.runFlux('should not bill')
  ok(gated.provider === 'placeholder' && !urls().some((u) => /openai\.com|replicate\.com/.test(u)), 'opt-in: keys present, flags absent, no paid host is contacted')

  process.env.IMAGE_OPENAI = '1'
  process.env.IMAGE_PROVIDER = 'openai'
  handler = async (url) => {
    if (url.includes('/images/generations')) return json(403, { error: { message: 'Your organization must be verified to use the model.' } })
    return new Response('unexpected ' + url, { status: 500 })
  }
  let orgErr = ''
  try { await img.runFlux('portrait') } catch (e: any) { orgErr = e.message }
  ok(urls().some((u) => u.includes('/images/generations')), 'opt-in: OpenAI is called only when IMAGE_PROVIDER and IMAGE_OPENAI are set')
  ok(!/organization must be verified/i.test(orgErr) && /IMAGE_OPENAI|pay-per-image|off/i.test(orgErr), `opt-in: organization-verification text is replaced (${orgErr.slice(0, 160)})`)

  img.resetImageGenForTests()
  installFetch()
  process.env.IMAGE_OPENAI = '1'
  process.env.IMAGE_PROVIDER = 'openai'
  let strictPaid = ''
  try { await img.runFlux('portrait', { strict: true }) } catch (e: any) { strictPaid = e.message }
  ok(/paid run|never|not use OpenAI/i.test(strictPaid) && !urls().some((u) => u.includes('openai.com')), `opt-in: strict refuses OpenAI without calling it (${strictPaid.slice(0, 140)})`)

  // replicate generation opt-in, and upscale opt-in defaults to sharp
  img.resetImageGenForTests()
  installFetch()
  resetEnv()
  process.env.DATA_DIR = dir
  process.env.REPLICATE_API_TOKEN = 'r8_test'
  process.env.POLLINATIONS = 'off'
  handler = async () => json(200, { data: [{ b64_json: PNG.toString('base64') }] })
  const noRep = await img.runFlux('local only')
  ok(noRep.provider === 'placeholder' && !urls().some((u) => u.includes('replicate.com')), 'opt-in: Replicate image generation stays off')

  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer()
  installFetch()
  handler = async () => { throw new Error('replicate must not be called') }
  const sharpUp = await services.runUpscaler(tiny, 2)
  ok(sharpUp.engine === 'sharp-lanczos3' && urls().length === 0, `upscale: token without REPLICATE_UPSCALE stays on sharp (${sharpUp.engine}, calls ${urls().length})`)

  process.env.REPLICATE_UPSCALE = '1'
  installFetch()
  handler = async (url) => {
    if (url.includes('api.replicate.com/v1/')) return json(201, { status: 'succeeded', output: 'https://cdn.example/up.png' })
    if (url.includes('cdn.example/up.png')) return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
  const aiUp = await services.runUpscaler(tiny, 2)
  ok(aiUp.engine === 'replicate-real-esrgan' && urls().some((u) => u.includes('api.replicate.com')), `upscale: REPLICATE_UPSCALE=1 opts in (${aiUp.engine})`)

  // --- Pollinations queue: one at a time, interval, cache ---
  img.resetImageGenForTests()
  installFetch()
  resetEnv()
  process.env.DATA_DIR = dir
  process.env.POLLINATIONS_MIN_INTERVAL_MS = '150'
  const starts: number[] = []
  let pollInFlight = 0
  let pollMax = 0
  handler = async (url) => {
    if (!url.includes('image.pollinations.ai')) return new Response('unexpected ' + url, { status: 500 })
    pollInFlight++
    pollMax = Math.max(pollMax, pollInFlight)
    starts.push(Date.now())
    await new Promise((r) => setTimeout(r, 30))
    pollInFlight--
    return png()
  }
  const [a, b] = await Promise.all([img.runFlux('prompt-a'), img.runFlux('prompt-b')])
  ok(a.provider === 'pollinations' && b.provider === 'pollinations', 'queue: both prompts resolve through Pollinations')
  ok(pollMax === 1, `queue: one Pollinations request at a time (max in flight ${pollMax})`)
  ok(starts.length === 2 && starts[1] - starts[0] >= 140, `queue: second start waits out the interval (${starts[1] - starts[0]} ms)`)
  const beforeCache = pollCalls().length
  const cached = await img.runFlux('prompt-a')
  ok(cached.cached === true && cached.provider === 'pollinations' && pollCalls().length === beforeCache, 'queue: a repeated prompt is served from cache')

  // ComfyUI when configured, after Pollinations is off
  img.resetImageGenForTests()
  installFetch()
  process.env.POLLINATIONS = 'off'
  process.env.COMFYUI_URL = 'http://127.0.0.1:8188'
  handler = async (url, init) => {
    if (url.endsWith('/generate') && init?.method === 'POST') return png()
    return new Response('unexpected ' + url, { status: 500 })
  }
  const local = await img.runFlux('studio lamp')
  ok(local.provider === 'comfyui' && local.paid === false && local.mocked === false, `comfyui: configured local worker is used (${local.provider})`)

  // pipeline strict records the failure instead of a placeholder image
  img.resetImageGenForTests()
  installFetch()
  resetEnv()
  process.env.DATA_DIR = dir
  process.env.POLLINATIONS = 'off'
  const ran = await pipeline.runPipeline([{ id: 'gen', type: 'flux-schnell', data: {} }], [], { prompt: 'sneaker', strict: true })
  ok(ran.status === 'failed' && /HF_TOKEN|paid run stopped|not configured/i.test(ran.results.gen?.error || ''), `pipeline strict: fails closed (${ran.results.gen?.error})`)
  ok(!ran.imageUrl, 'pipeline strict: no image is saved when generation is refused')

  const loose = await pipeline.runPipeline([{ id: 'gen', type: 'flux-schnell', data: {} }], [], { prompt: 'sneaker' })
  ok(loose.status === 'success' && loose.results.gen?.provider === 'placeholder' && loose.results.gen?.mocked === true, `pipeline: a free run records the placeholder provider (${loose.results.gen?.provider})`)
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
