// Free-first image generation. Every canvas, pipeline, buyer, and agent image goes through runFlux.
// Order: Hugging Face Inference fal-ai FLUX.1-schnell (monthly cap, included credits) ->
// Pollinations anonymous (one at a time, watermark) -> local ComfyUI if configured ->
// a clearly marked offline placeholder.
// OpenAI Images and Replicate are not in that chain. They run only when IMAGE_PROVIDER names them
// and the matching opt-in is set, and never for strict/buyer runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

export type ImageGenResult = {
  png: Buffer
  mocked: boolean
  engine: string
  provider: string
  model: string
  watermark: boolean
  paid: boolean
  included: boolean
  note: string
  cached?: boolean
}

const FAL_IDS: Record<string, string> = {
  'black-forest-labs/FLUX.1-schnell': 'fal-ai/flux/schnell',
  'black-forest-labs/FLUX.1-dev': 'fal-ai/flux/dev'
}
const DEFAULT_CAP = 80 // images / UTC month. Sized to stay well inside a typical HF Pro included inference credit.
const DEFAULT_POLL_GAP_MS = 45_000

let fetchOverride: typeof fetch | null = null
const pollCache = new Map<string, Buffer>()
let pollTail: Promise<void> = Promise.resolve()
let pollLastStarted = 0

export function setImageFetchForTests(fn: typeof fetch | null) {
  fetchOverride = fn
}

export function imageFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (fetchOverride || globalThis.fetch)(input, init)
}

function usagePath() {
  return `${process.env.DATA_DIR || './data'}/image-gen-usage.json`
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7)
}

export function hfMonthlyCount(): number {
  try {
    const j = JSON.parse(readFileSync(usagePath(), 'utf8'))
    if (j.month !== monthKey()) return 0
    return Number(j.hf) || 0
  } catch {
    return 0
  }
}

function bumpHf() {
  const month = monthKey()
  let hf = 0
  try {
    const j = JSON.parse(readFileSync(usagePath(), 'utf8'))
    if (j.month === month) hf = Number(j.hf) || 0
  } catch { /* first image this month */ }
  const path = usagePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ month, hf: hf + 1 }))
}

export function monthlyCap(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.HF_FLUX_MONTHLY_CAP
  if (raw == null || String(raw).trim() === '') return DEFAULT_CAP
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CAP
  return Math.floor(n)
}

function truthy(v: string | undefined) {
  return !!v && !['0', 'off', 'false', 'no'].includes(v.trim().toLowerCase())
}

function pollinationsOn(env: NodeJS.ProcessEnv) {
  const v = env.POLLINATIONS
  if (v == null || v.trim() === '') return true
  return truthy(v)
}

function pollGapMs() {
  const raw = process.env.POLLINATIONS_MIN_INTERVAL_MS
  if (raw == null || raw.trim() === '') return DEFAULT_POLL_GAP_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_POLL_GAP_MS
}

/** Route ids in the order runFlux will try them. Paid routes are absent unless explicitly selected. */
export function planImageRoutes(env: NodeJS.ProcessEnv = process.env, opts: { strict?: boolean; hfUsed?: number } = {}): string[] {
  const strict = !!opts.strict
  const forced = (env.IMAGE_PROVIDER || '').trim().toLowerCase()
  if (forced === 'openai' || forced === 'replicate') {
    if (strict) return []
    if (forced === 'openai' && truthy(env.IMAGE_OPENAI) && env.OPENAI_API_KEY) return ['openai']
    if (forced === 'replicate' && truthy(env.IMAGE_REPLICATE) && env.REPLICATE_API_TOKEN) return ['replicate']
    return []
  }
  const routes: string[] = []
  const cap = monthlyCap(env)
  const used = opts.hfUsed ?? hfMonthlyCount()
  if (env.HF_TOKEN && cap > 0 && used < cap) {
    if (env.HF_FLUX_URL) routes.push('hf-url')
    else {
      for (const name of (env.HF_FLUX_PROVIDER || 'fal-ai').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        if (name === 'fal-ai') routes.push('hf-fal-ai')
        else if (name === 'nscale') routes.push('hf-nscale')
        else if (name === 'url') routes.push('hf-url')
      }
    }
  }
  if (!strict && pollinationsOn(env)) routes.push('pollinations')
  if (env.COMFYUI_URL && env.COMFYUI_URL.trim()) routes.push('comfyui')
  if (!strict) routes.push('placeholder')
  return routes
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string))
}

function pack(partial: Omit<ImageGenResult, 'png'> & { png: Buffer }): ImageGenResult {
  return partial
}

export function offlinePlaceholderNote(prompt: string) {
  return `OFFLINE PLACEHOLDER - not a generated photo. Nothing was sent to a paid API. Prompt: ${prompt.slice(0, 80)}`
}

async function placeholder(prompt: string): Promise<ImageGenResult> {
  const note = offlinePlaceholderNote(prompt)
  const svg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#e5e7eb"/><rect x="64" y="64" width="896" height="896" fill="none" stroke="#111" stroke-width="8" stroke-dasharray="16 12"/><text x="50%" y="460" text-anchor="middle" fill="#111" font-family="monospace" font-size="36">OFFLINE PLACEHOLDER</text><text x="50%" y="520" text-anchor="middle" fill="#333" font-family="monospace" font-size="22">not a generated photo</text><text x="50%" y="620" text-anchor="middle" fill="#111" font-family="monospace" font-size="20">${escapeXml(prompt.slice(0, 60))}</text></svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  return pack({ png, mocked: true, engine: 'placeholder', provider: 'placeholder', model: 'offline-placeholder', watermark: false, paid: false, included: false, note })
}

function modelId() {
  return process.env.HF_FLUX_MODEL || 'black-forest-labs/FLUX.1-schnell'
}

async function hf(route: string, prompt: string): Promise<ImageGenResult> {
  const token = process.env.HF_TOKEN || ''
  const model = modelId()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const signal = AbortSignal.timeout(120000)
  const steps = /schnell/i.test(model) ? 4 : 28
  let raw: Buffer
  if (route === 'hf-nscale') {
    const r = await imageFetch('https://router.huggingface.co/nscale/v1/images/generations', {
      signal, method: 'POST', headers,
      body: JSON.stringify({ model, prompt, size: '1024x1024', response_format: 'b64_json' })
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 200)}`)
    const b64 = JSON.parse(text)?.data?.[0]?.b64_json
    if (!b64) throw new Error('no image in response')
    raw = Buffer.from(b64, 'base64')
  } else if (route === 'hf-fal-ai') {
    const id = FAL_IDS[model]
    if (!id) throw new Error(`no fal-ai mapping for ${model}`)
    const r = await imageFetch(`https://router.huggingface.co/fal-ai/${id}`, {
      signal, method: 'POST', headers,
      body: JSON.stringify({ prompt, num_inference_steps: steps, image_size: { width: 1024, height: 1024 } })
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 200)}`)
    const imgUrl = JSON.parse(text)?.images?.[0]?.url
    if (!imgUrl) throw new Error('no image in response')
    const ir = await imageFetch(imgUrl, { signal })
    if (!ir.ok) throw new Error(`image download ${ir.status}`)
    raw = Buffer.from(await ir.arrayBuffer())
  } else {
    const url = process.env.HF_FLUX_URL || `https://router.huggingface.co/hf-inference/models/${model}`
    const r = await imageFetch(url, {
      signal, method: 'POST', headers,
      body: JSON.stringify({ inputs: prompt, parameters: { num_inference_steps: steps, guidance_scale: 0 } })
    })
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
    raw = Buffer.from(await r.arrayBuffer())
  }
  const png = await sharp(raw).png().toBuffer()
  const which = route === 'hf-nscale' ? 'nscale' : route === 'hf-url' ? 'url' : 'fal-ai'
  return pack({
    png, mocked: false, engine: `hf-${which}:${model.split('/').pop()}`, provider: route, model,
    watermark: false, paid: false, included: true,
    note: `Hugging Face Inference (${which}) ${model.split('/').pop()}, counted against the monthly included-credit cap.`
  })
}

async function fetchPollinations(prompt: string): Promise<Buffer> {
  const q = new URLSearchParams({ width: '1024', height: '1024', model: 'flux', nologo: 'false', enhance: 'false' })
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`
  const r = await imageFetch(url, {
    signal: AbortSignal.timeout(60000),
    headers: { Accept: 'image/png,image/jpeg,image/*', 'User-Agent': 'fraymus-fly-io/image-gen' }
  })
  const buf = Buffer.from(await r.arrayBuffer())
  const ct = r.headers.get('content-type') || ''
  if (!r.ok || ct.includes('text/') || ct.includes('json')) throw new Error(`pollinations ${r.status}: ${buf.toString('utf8').slice(0, 160)}`)
  return sharp(buf).png().toBuffer()
}

function pollResult(png: Buffer, cached: boolean): ImageGenResult {
  return pack({
    png, mocked: false, engine: 'pollinations:flux', provider: 'pollinations', model: 'flux',
    watermark: true, paid: false, included: false, cached,
    note: 'Pollinations anonymous free image. It includes their watermark.'
  })
}

function pollinations(prompt: string): Promise<ImageGenResult> {
  const key = prompt.trim()
  const hit = pollCache.get(key)
  if (hit) return Promise.resolve(pollResult(hit, true))
  const job = pollTail.then(async () => {
    const again = pollCache.get(key)
    if (again) return pollResult(again, true)
    const wait = pollLastStarted ? Math.max(0, pollLastStarted + pollGapMs() - Date.now()) : 0
    if (wait) await new Promise((r) => setTimeout(r, wait))
    const afterWait = pollCache.get(key)
    if (afterWait) return pollResult(afterWait, true)
    pollLastStarted = Date.now()
    const png = await fetchPollinations(prompt)
    pollCache.set(key, png)
    if (pollCache.size > 64) pollCache.delete(pollCache.keys().next().value!)
    return pollResult(png, false)
  })
  pollTail = job.then(() => {}, () => {})
  return job
}

async function comfy(prompt: string): Promise<ImageGenResult> {
  const base = (process.env.COMFYUI_URL || '').replace(/\/$/, '')
  const raw = process.env.COMFYUI_CHECKPOINT ? await comfyWorkflow(base, prompt) : await comfyGenerate(base, prompt)
  const png = await sharp(raw).png().toBuffer()
  return pack({
    png, mocked: false, engine: 'comfyui', provider: 'comfyui', model: process.env.COMFYUI_CHECKPOINT || 'local',
    watermark: false, paid: false, included: false, note: 'Local ComfyUI (no per-call charge).'
  })
}

async function comfyGenerate(base: string, prompt: string): Promise<Buffer> {
  const r = await imageFetch(`${base}/generate`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', Accept: 'image/png, application/json' },
    body: JSON.stringify({ prompt, width: 1024, height: 1024 })
  })
  if (!r.ok) throw new Error(`comfyui ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('json')) return Buffer.from(await r.arrayBuffer())
  const j: any = await r.json()
  const b64 = j.png || j.image || (Array.isArray(j.images) ? j.images[0] : '')
  if (typeof b64 === 'string' && /^https?:/.test(b64)) {
    const ir = await imageFetch(b64)
    if (!ir.ok) throw new Error(`comfyui image ${ir.status}`)
    return Buffer.from(await ir.arrayBuffer())
  }
  if (typeof b64 === 'string' && b64) return Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  throw new Error('comfyui response had no image')
}

async function comfyWorkflow(base: string, prompt: string): Promise<Buffer> {
  const ckpt = process.env.COMFYUI_CHECKPOINT
  const graph = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: Date.now() % 1_000_000_000, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'fraymus', images: ['8', 0] } }
  }
  const r = await imageFetch(`${base}/prompt`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'fraymus', prompt: graph })
  })
  const queued: any = await r.json().catch(() => ({}))
  if (!r.ok || !queued.prompt_id) throw new Error(`comfyui prompt ${r.status}: ${JSON.stringify(queued).slice(0, 200)}`)
  if (queued.node_errors && Object.keys(queued.node_errors).length) throw new Error('comfyui rejected the workflow')
  let image: { filename: string; subfolder?: string; type?: string } | undefined
  for (let i = 0; i < 60 && !image; i++) {
    if (i) await new Promise((res) => setTimeout(res, 1000))
    const h = await imageFetch(`${base}/history/${queued.prompt_id}`, { signal: AbortSignal.timeout(15000) })
    const hist: any = await h.json().catch(() => ({}))
    const outputs = hist?.[queued.prompt_id]?.outputs || {}
    for (const node of Object.values(outputs) as any[]) {
      if (node?.images?.[0]?.filename) { image = node.images[0]; break }
    }
  }
  if (!image) throw new Error('comfyui produced no image')
  const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
  const view = await imageFetch(`${base}/view?${q}`)
  if (!view.ok) throw new Error(`comfyui view ${view.status}`)
  return Buffer.from(await view.arrayBuffer())
}

function openaiRefusal(status: number, text: string) {
  // Never surface the provider's organization-verification wording. This route is off unless opted in.
  if (/organiz/i.test(text) && /verif/i.test(text)) {
    return 'OpenAI Images refused this account. This route is pay-per-image and stays off unless IMAGE_OPENAI=1 and IMAGE_PROVIDER=openai. Buyer runs never use it.'
  }
  return `OpenAI Images failed (${status}). This route is pay-per-image and stays off unless IMAGE_OPENAI=1 and IMAGE_PROVIDER=openai.`
}

async function openai(prompt: string): Promise<ImageGenResult> {
  const base = (process.env.OPENAI_IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
  const r = await imageFetch(`${base}/images/generations`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size: '1024x1024', n: 1 })
  })
  const text = await r.text()
  if (!r.ok) throw new Error(openaiRefusal(r.status, text))
  const j: any = JSON.parse(text)
  const b64 = j?.data?.[0]?.b64_json
  let raw: Buffer
  if (b64) raw = Buffer.from(b64, 'base64')
  else if (j?.data?.[0]?.url) {
    const ir = await imageFetch(j.data[0].url)
    if (!ir.ok) throw new Error(`OpenAI image download ${ir.status}`)
    raw = Buffer.from(await ir.arrayBuffer())
  } else throw new Error('OpenAI Images returned no image')
  const png = await sharp(raw).png().toBuffer()
  return pack({
    png, mocked: false, engine: `openai:${model}`, provider: 'openai', model,
    watermark: false, paid: true, included: false,
    note: 'OpenAI Images (pay-per-image, explicit opt-in). Not used for buyer runs.'
  })
}

async function replicateImage(prompt: string): Promise<ImageGenResult> {
  const model = process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-schnell'
  const raw = await replicatePredict(model, { prompt, num_outputs: 1, aspect_ratio: '1:1', output_format: 'png', go_fast: true })
  const png = await sharp(raw).png().toBuffer()
  return pack({
    png, mocked: false, engine: `replicate:${model.split('/').pop()}`, provider: 'replicate', model,
    watermark: false, paid: true, included: false,
    note: 'Replicate image generation (pay-per-image, explicit opt-in). Not used for buyer runs.'
  })
}

/** Shared by opted-in Replicate image generation and opted-in Real-ESRGAN upscaling. */
export async function replicatePredict(model: string, input: Record<string, unknown>): Promise<Buffer> {
  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set')
  const versioned = model.includes(':')
  const url = versioned
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${model}/predictions`
  const body: Record<string, unknown> = { input }
  if (versioned) body.version = model.split(':')[1]
  const r = await imageFetch(url, {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
    body: JSON.stringify(body)
  })
  let pred: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Replicate failed ${r.status}: ${JSON.stringify(pred).slice(0, 300)}`)
  for (let i = 0; i < 60 && pred && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
    await new Promise((res) => setTimeout(res, 2000))
    pred = await (await imageFetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } })).json()
  }
  if (pred?.status !== 'succeeded') throw new Error(`Replicate prediction ${pred?.status}: ${pred?.error || ''}`)
  const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output
  const ir = await imageFetch(outUrl)
  if (!ir.ok) throw new Error(`Replicate output ${ir.status}`)
  return Buffer.from(await ir.arrayBuffer())
}

async function runRoute(route: string, prompt: string): Promise<ImageGenResult> {
  if (route === 'hf-fal-ai' || route === 'hf-nscale' || route === 'hf-url') return hf(route, prompt)
  if (route === 'pollinations') return pollinations(prompt)
  if (route === 'comfyui') return comfy(prompt)
  if (route === 'openai') return openai(prompt)
  if (route === 'replicate') return replicateImage(prompt)
  if (route === 'placeholder') return placeholder(prompt)
  throw new Error(`unknown image route ${route}`)
}

function closedMessage(): string {
  const forced = (process.env.IMAGE_PROVIDER || '').trim().toLowerCase()
  if (forced === 'openai') return 'Paid runs never use OpenAI Images. This route is pay-per-image and was not called.'
  if (forced === 'replicate') return 'Paid runs never use Replicate image generation. This route is pay-per-image and was not called.'
  const cap = monthlyCap()
  const used = hfMonthlyCount()
  if (process.env.HF_TOKEN && cap > 0 && used >= cap) {
    return `Paid run stopped: the Hugging Face monthly image cap is used up (${used}/${cap}). Not falling back to Pollinations, a placeholder, or a paid API. This run should be refunded.`
  }
  return 'Paid run stopped: no included image route is configured (set HF_TOKEN for Hugging Face FLUX, or COMFYUI_URL for a local worker). Not falling back to Pollinations, a placeholder, or a paid API. This run should be refunded.'
}

export function resetImageGenForTests() {
  pollCache.clear()
  pollLastStarted = 0
  pollTail = Promise.resolve()
  fetchOverride = null
  try { rmSync(usagePath(), { force: true }) } catch { /* no usage file yet */ }
}

export async function runFlux(prompt: string, opts: { strict?: boolean } = {}): Promise<ImageGenResult> {
  const strict = !!opts.strict
  const routes = planImageRoutes(process.env, { strict, hfUsed: hfMonthlyCount() })
  if (!routes.length) throw new Error(closedMessage())
  const errors: string[] = []
  for (const route of routes) {
    try {
      const result = await runRoute(route, prompt)
      if (route.startsWith('hf-')) bumpHf()
      return result
    } catch (e: any) {
      const message = e?.message || String(e)
      errors.push(`${route}: ${message}`)
      console.warn(`[image] ${route} skipped: ${message.slice(0, 180)}`)
      const forced = (process.env.IMAGE_PROVIDER || '').trim().toLowerCase()
      if ((forced === 'openai' || forced === 'replicate') && route === forced) throw new Error(message)
    }
  }
  if (strict) {
    throw new Error(`Paid run stopped: included image route failed (${errors.join(' | ').slice(0, 300)}). Not falling back to Pollinations, a placeholder, or a paid API. This run should be refunded.`)
  }
  return placeholder(prompt)
}
