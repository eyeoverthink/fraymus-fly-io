// Free-first image generation. runFlux is the only image entry point
// (canvas, /api/flux, buyer pipeline, generate_image).
//
// Default order: Hugging Face router fal-ai FLUX.1-schnell (included subscription
// credits, local monthly cap; IMAGE_ALLOW_PAID_OVERRUN defaults off) -> Gemini
// (only when GEMINI_API_KEY is set; Google lists no free tier for that image model)
// -> Pollinations (no key) -> a local server (LOCAL_IMAGE_URL).
// OpenAI Images and Replicate are called only when that name is listed in
// IMAGE_PROVIDERS and its key is set. A key alone does nothing.
// If every provider that actually ran fails, the error names each one and why.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

export type CostMode = 'free' | 'paid' | 'included-credit' | 'offline'
export type ImageAttempt = { provider: string; status: string; durationMs: number }
export type ImageResult = {
  png: Buffer
  mocked: boolean
  engine: string
  model: string
  costMode: CostMode
  width?: number
  height?: number
  watermark?: boolean
  attempts: ImageAttempt[]
}

export const DEFAULT_IMAGE_PROVIDERS = ['huggingface', 'gemini', 'pollinations', 'local'] as const
export const PAID_IMAGE_PROVIDERS = ['openai', 'replicate'] as const
const KNOWN = new Set<string>([...DEFAULT_IMAGE_PROVIDERS, ...PAID_IMAGE_PROVIDERS, 'placeholder'])
const SECRET_ENV = ['HF_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'REPLICATE_API_TOKEN', 'LOCAL_IMAGE_TOKEN', 'PROMPT_LLM_API_KEY', 'XAI_API_KEY'] as const

let fetchOverride: typeof fetch | null = null
const pollCache = new Map<string, Buffer>()
let pollTail: Promise<void> = Promise.resolve()

export function setImageFetchForTests(fn: typeof fetch | null) {
  fetchOverride = fn
}
export function imageFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (fetchOverride || globalThis.fetch)(input, init)
}

function num(v: string | undefined, fallback: number) {
  if (v == null || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function timeoutMs() { return Math.max(1000, num(process.env.IMAGE_GENERATION_TIMEOUT_MS, 90_000)) }
function maxBytes() { return Math.max(1024, num(process.env.IMAGE_DOWNLOAD_MAX_BYTES, 25_000_000)) }
function monthlyCap() { return Math.max(0, num(process.env.IMAGE_MONTHLY_CREDIT_CAP_USD, 1.5)) }
function pricePerMp() { return Math.max(0, num(process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD, 0.003)) }
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7) }
function estimateUsd(w: number, h: number) { return (w * h / 1_000_000) * pricePerMp() }
function overrunAllowed() {
  const v = (process.env.IMAGE_ALLOW_PAID_OVERRUN || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

const FAL_IDS: Record<string, string> = {
  'black-forest-labs/FLUX.1-schnell': 'fal-ai/flux/schnell',
  'black-forest-labs/FLUX.1-dev': 'fal-ai/flux/dev',
  'stabilityai/stable-diffusion-xl-base-1.0': 'fal-ai/fast-sdxl'
}
const HF_W = 1024
const HF_H = 1024

let budget: any = null
let budgetPath = ''
let budgetOpen: Promise<void> | null = null
let budgetGate: Promise<void> = Promise.resolve()

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = budgetGate.then(fn, fn)
  budgetGate = run.then(() => undefined, () => undefined)
  return run
}

async function budgetDb() {
  const path = `${process.env.DATA_DIR || './data'}/image-budget.sqlite`
  if (budget && budgetPath === path) return budget
  if (!budgetOpen) {
    budgetOpen = (async () => {
      if (budget) { try { budget.close() } catch { /* already closed */ } budget = null }
      mkdirSync(dirname(path), { recursive: true })
      const { DatabaseSync } = await import('node:sqlite')
      budget = new DatabaseSync(path)
      budget.exec(`create table if not exists image_calls (
        id integer primary key autoincrement,
        month text not null,
        provider text not null,
        status text not null,
        estimated_usd real not null,
        actual_usd real,
        width integer,
        height integer,
        created_at integer not null
      )`)
      budgetPath = path
    })()
  }
  await budgetOpen
  budgetOpen = null
  return budget
}

async function reserveHf(estimate: number): Promise<{ id: number } | { blocked: true }> {
  return exclusive(async () => {
    const db = await budgetDb()
    const month = monthKey()
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare(`select coalesce(sum(estimated_usd), 0) as spent from image_calls where month = ? and status in ('reserved', 'succeeded', 'quota-exhausted')`).get(month) as { spent: number }
      const spent = Number(row?.spent) || 0
      const quota = db.prepare(`select count(*) as n from image_calls where month = ? and status = 'quota-exhausted'`).get(month) as { n: number }
      if (Number(quota?.n) > 0 || (!overrunAllowed() && spent + estimate > monthlyCap() + 1e-9)) {
        db.prepare(`insert into image_calls (month, provider, status, estimated_usd, created_at) values (?, 'hf-fal', 'cap-blocked', 0, ?)`).run(month, Date.now())
        db.exec('COMMIT')
        return { blocked: true }
      }
      const info = db.prepare(`insert into image_calls (month, provider, status, estimated_usd, created_at) values (?, 'hf-fal', 'reserved', ?, ?)`).run(month, estimate, Date.now())
      db.exec('COMMIT')
      return { id: Number(info.lastInsertRowid) }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* no open transaction */ }
      throw e
    }
  })
}

async function finishHf(id: number, width: number, height: number) {
  const db = await budgetDb()
  db.prepare(`update image_calls set status = 'succeeded', actual_usd = ?, width = ?, height = ? where id = ?`).run(estimateUsd(width, height), width, height, id)
}

async function releaseHf(id: number) {
  const db = await budgetDb()
  db.prepare(`update image_calls set status = 'failed', actual_usd = 0 where id = ?`).run(id)
}

/** HF said the included credits are gone. Later calls skip fal-ai until next month. */
async function exhaustHfQuota() {
  const db = await budgetDb()
  db.prepare(`insert into image_calls (month, provider, status, estimated_usd, created_at) values (?, 'hf-fal', 'quota-exhausted', ?, ?)`).run(monthKey(), monthlyCap(), Date.now())
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let s = String(text || '')
  for (const key of SECRET_ENV) {
    const value = env[key]?.trim()
    if (value && value.length >= 8) s = s.split(value).join('[redacted]')
  }
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_\-]{8,})\b/g, '[redacted]')
    .replace(/\b(hf_[A-Za-z0-9]{8,})\b/g, '[redacted]')
    .replace(/\b(AIza[0-9A-Za-z_\-]{10,})\b/g, '[redacted]')
    .replace(/\b(r8_[A-Za-z0-9]{8,})\b/g, '[redacted]')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"]+/gi, '$1[redacted]')
}

function clip(s: string, max = 180) {
  return redactSecrets(s).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Names from IMAGE_PROVIDERS (or the buyer list when strict). `hf-fal` is the Hugging Face router path. */
export function listedImageProviders(opts: { strict?: boolean } = {}): string[] {
  const raw = opts.strict
    ? (process.env.BUYER_IMAGE_PROVIDERS ?? 'huggingface')
    : process.env.IMAGE_PROVIDERS
  const source = raw === undefined ? DEFAULT_IMAGE_PROVIDERS.join(',') : raw
  const names = source.split(',').map((s) => s.trim().toLowerCase()).filter((n) => n && n !== 'none')
  if (!names.length || names.every((n) => n === 'none')) return []
  const out: string[] = []
  for (const name of names) {
    const mapped = name === 'hf-fal' ? 'huggingface' : name
    if (opts.strict && mapped === 'placeholder') continue
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

function configured(name: string): boolean {
  switch (name) {
    case 'huggingface': return !!process.env.HF_TOKEN?.trim()
    case 'gemini': return !!process.env.GEMINI_API_KEY?.trim()
    case 'pollinations': return true
    case 'local': return !!(process.env.LOCAL_IMAGE_URL || process.env.LOCAL_IMAGE_ENDPOINT || '').trim()
    case 'openai': return !!process.env.OPENAI_API_KEY?.trim()
    case 'replicate': return !!process.env.REPLICATE_API_TOKEN?.trim()
    case 'placeholder': return true
    default: return false
  }
}

function skipReason(name: string): string {
  switch (name) {
    case 'huggingface': return 'HF_TOKEN not set'
    case 'gemini': return 'GEMINI_API_KEY not set'
    case 'local': return 'LOCAL_IMAGE_URL not set'
    case 'openai': return 'OPENAI_API_KEY not set'
    case 'replicate': return 'REPLICATE_API_TOKEN not set'
    default: return 'unknown provider'
  }
}

/** Providers that will actually be called, in order. Paid names stay out unless listed and keyed. */
export function imageProviderPlan(opts: { strict?: boolean } = {}): string[] {
  return listedImageProviders(opts).filter((name) => KNOWN.has(name) && configured(name) && name !== 'placeholder')
}

/** Replicate upscale is off unless the name is listed, the token is set, and ENABLE_PAID_REPLICATE=1. */
export function replicateUpscaleOptIn(): boolean {
  const listed = (process.env.IMAGE_PROVIDERS || '').split(',').map((s) => s.trim().toLowerCase()).includes('replicate')
  return listed && process.env.ENABLE_PAID_REPLICATE === '1' && !!process.env.REPLICATE_API_TOKEN?.trim()
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string))
}

async function readLimited(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes()) throw new Error(`image too large (${declared} bytes)`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes()) throw new Error(`image too large (${buf.length} bytes)`)
  return buf
}

async function normalizePng(raw: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  let meta: sharp.Metadata
  try { meta = await sharp(raw, { limitInputPixels: 4096 * 4096 }).metadata() } catch {
    throw new Error('response was not a decodable image')
  }
  const width = meta.width || 0
  const height = meta.height || 0
  if (!width || !height || width * height > 4096 * 4096) throw new Error('decoded image too large')
  const png = await sharp(raw, { limitInputPixels: 4096 * 4096 }).png().toBuffer()
  if (png.length > maxBytes()) throw new Error('normalized png too large')
  return { png, width, height }
}

function isImage(buf: Buffer, contentType: string): boolean {
  const ct = contentType.split(';')[0].trim().toLowerCase()
  if (ct.startsWith('text/') || ct.includes('json') || ct.includes('html') || ct.includes('xml')) return false
  if (buf.length < 32) return false
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  const gif = buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a'
  if (png || jpeg || webp || gif) return true
  return ct.startsWith('image/')
}

function errorDetail(status: number, text: string): string {
  let detail = text
  try {
    const j = JSON.parse(text)
    const inner = j?.error?.message || j?.error?.error || (typeof j?.error === 'string' ? j.error : '') || j?.detail || j?.message || ''
    if (inner) detail = typeof inner === 'string' ? inner : JSON.stringify(inner)
  } catch { /* body is not JSON */ }
  return clip(`${status} ${detail}`)
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, ms = timeoutMs()): Promise<Response> {
  return imageFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hfModels(): string[] {
  const one = process.env.HF_FLUX_MODEL?.trim() || process.env.HF_IMAGE_MODEL?.trim()
  if (one) return [one]
  return (process.env.HF_IMAGE_MODELS || 'black-forest-labs/FLUX.1-schnell')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

// FLUX through the HF router. hf-inference returns HTTP 410 for these models.
// fal-ai is billed by Hugging Face against included subscription credits.
async function fromHuggingFace(prompt: string): Promise<{ png: Buffer; model: string }> {
  const provider = (process.env.HF_FLUX_PROVIDER || 'fal-ai').trim().toLowerCase()
  if (provider !== 'fal-ai') throw new Error(`unsupported HF_FLUX_PROVIDER ${provider}; fal-ai is the routed provider`)
  const errors: string[] = []
  let reserved = false
  for (const model of hfModels()) {
    const id = FAL_IDS[model]
    if (!id) { errors.push(`${model} no fal-ai mapping`); continue }
    const slot = await reserveHf(estimateUsd(HF_W, HF_H))
    if ('blocked' in slot) throw new Error('cap-exceeded')
    reserved = true
    try {
      const schnell = /schnell/i.test(model)
      const res = await postJson(`https://router.huggingface.co/fal-ai/${id}`, {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json'
      }, {
        prompt,
        num_inference_steps: schnell ? 4 : 28,
        image_size: { width: HF_W, height: HF_H }
      })
      const text = await res.text()
      if (!res.ok) {
        if (res.status === 402) await exhaustHfQuota()
        const stop = res.status === 401 || res.status === 402 || res.status === 403
        errors.push(`${model} ${errorDetail(res.status, text.slice(0, 400))}`)
        await releaseHf(slot.id)
        if (stop) break
        continue
      }
      let imgUrl = ''
      try { imgUrl = JSON.parse(text)?.images?.[0]?.url || '' } catch { /* not json */ }
      if (!imgUrl) {
        errors.push(`${model} invalid json`)
        await releaseHf(slot.id)
        continue
      }
      const ir = await imageFetch(imgUrl, { signal: AbortSignal.timeout(timeoutMs()) })
      if (!ir.ok) {
        errors.push(`${model} image download ${ir.status}`)
        await releaseHf(slot.id)
        continue
      }
      const norm = await normalizePng(await readLimited(ir))
      await finishHf(slot.id, norm.width, norm.height)
      return { png: norm.png, model }
    } catch (e: any) {
      if (String(e?.message || e) === 'cap-exceeded') throw e
      try { await releaseHf(slot.id) } catch { /* reservation already closed */ }
      errors.push(`${model} ${clip(e?.message || String(e))}`)
    }
  }
  if (!reserved && errors.length === 0) throw new Error('cap-exceeded')
  throw new Error(errors.join('; ') || 'Hugging Face image failed')
}

async function fromGemini(prompt: string): Promise<{ png: Buffer; model: string }> {
  const model = process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-2.5-flash-image'
  const res = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    'Content-Type': 'application/json',
    'x-goog-api-key': process.env.GEMINI_API_KEY || ''
  }, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  })
  const text = (await readLimited(res)).toString('utf8')
  if (!res.ok) throw new Error(errorDetail(res.status, text.slice(0, 500)))
  let parsed: any
  try { parsed = JSON.parse(text) } catch { throw new Error(errorDetail(res.status, text.slice(0, 400))) }
  const parts = parsed?.candidates?.[0]?.content?.parts || []
  let data = ''
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data
    if (inline?.data) { data = inline.data; break }
  }
  if (!data) throw new Error(String(parsed?.promptFeedback?.blockReason || parsed?.candidates?.[0]?.finishReason || 'response had no image'))
  return { png: Buffer.from(data, 'base64'), model }
}

function pollCacheKey(prompt: string) { return `${prompt.trim()}\n768x768` }

async function fetchPollinations(prompt: string): Promise<Buffer> {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux`
  let last = 'pollinations failed'
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await imageFetch(url, {
      signal: AbortSignal.timeout(timeoutMs()),
      headers: { Accept: 'image/jpeg, image/png', 'User-Agent': 'fraymus-fly-io/image-gen' }
    })
    if (res.status === 402 || res.status === 429 || res.status >= 500) {
      last = errorDetail(res.status, (await res.text()).slice(0, 200))
      if (attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000
        await sleep(Math.min(wait, timeoutMs() / 4))
        continue
      }
      throw new Error(last)
    }
    const buf = await readLimited(res)
    const ct = res.headers.get('content-type') || ''
    if (!res.ok || !isImage(buf, ct)) throw new Error(errorDetail(res.status, ct ? `content-type ${ct}` : buf.toString('utf8').slice(0, 200)))
    return buf
  }
  throw new Error(last)
}

function pollinations(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  const key = pollCacheKey(prompt)
  const hit = pollCache.get(key)
  if (hit) {
    attempts.push({ provider: 'pollinations', status: 'cache', durationMs: 0 })
    return Promise.resolve(done('pollinations-classic', 'flux', 'free', hit, attempts, true))
  }
  const job = pollTail.then(async () => {
    const again = pollCache.get(key)
    if (again) {
      attempts.push({ provider: 'pollinations', status: 'cache', durationMs: 0 })
      return done('pollinations-classic', 'flux', 'free', again, attempts, true)
    }
    const t0 = Date.now()
    try {
      const raw = await fetchPollinations(prompt)
      const norm = await normalizePng(raw)
      pollCache.set(key, norm.png)
      if (pollCache.size > 64) pollCache.delete(pollCache.keys().next().value as string)
      attempts.push({ provider: 'pollinations', status: 'succeeded', durationMs: Date.now() - t0 })
      return done('pollinations-classic', 'flux', 'free', norm.png, attempts, true, norm.width, norm.height)
    } catch (e: any) {
      attempts.push({ provider: 'pollinations', status: clip(e?.message || String(e)), durationMs: Date.now() - t0 })
      return null
    }
  })
  pollTail = job.then(() => {}, () => {})
  return job
}

function assertNotPaidHost(raw: string) {
  let host = ''
  try { host = new URL(raw).hostname.toLowerCase() } catch { throw new Error('LOCAL_IMAGE_URL is not a valid URL') }
  if (host === 'api.openai.com' || host.endsWith('.openai.com') || host === 'api.replicate.com' || host.endsWith('.replicate.com')) {
    throw new Error('local image URL points at a paid host; list openai or replicate in IMAGE_PROVIDERS to opt in')
  }
}

function joinPath(base: string, path: string): string {
  const b = base.replace(/\/$/, '')
  return b.endsWith(path) ? b : b + path
}

function localBase(): string {
  return (process.env.LOCAL_IMAGE_URL || process.env.LOCAL_IMAGE_ENDPOINT || '').trim()
}

async function fromLocal(prompt: string): Promise<{ png: Buffer; model: string }> {
  const base = localBase()
  assertNotPaidHost(base)
  const kind = (process.env.LOCAL_IMAGE_KIND || 'a1111').trim().toLowerCase()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'image/png, application/json' }
  if (process.env.LOCAL_IMAGE_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.LOCAL_IMAGE_TOKEN.trim()}`
  if (kind === 'comfy') return fromComfy(prompt, base, headers)
  if (kind === 'openai' || kind === 'ollama') return fromLocalOpenAI(prompt, base, headers)
  if (kind === 'json') return fromLocalJson(prompt, base, headers)
  if (kind !== 'a1111' && kind !== 'automatic1111' && kind !== 'sdwebui') throw new Error(`unknown LOCAL_IMAGE_KIND ${kind}`)
  const res = await postJson(joinPath(base, '/sdapi/v1/txt2img'), headers, { prompt, steps: 4, width: 512, height: 512, cfg_scale: 1 }, 120_000)
  const buf = await readLimited(res)
  if (!res.ok) throw new Error(errorDetail(res.status, buf.toString('utf8').slice(0, 400)))
  let b64 = ''
  try { b64 = JSON.parse(buf.toString('utf8'))?.images?.[0] || '' } catch { /* not json */ }
  if (!b64) throw new Error('a1111 response had no images[0]')
  const raw = b64.includes(',') ? b64.split(',').pop()! : b64
  return { png: Buffer.from(raw, 'base64'), model: 'a1111' }
}

async function fromLocalJson(prompt: string, base: string, headers: Record<string, string>): Promise<{ png: Buffer; model: string }> {
  const res = await postJson(base, headers, { prompt, width: 768, height: 768 })
  if (!res.ok) throw new Error('Local image worker offline')
  const ct = res.headers.get('content-type') || ''
  const raw = ct.includes('json')
    ? Buffer.from((JSON.parse((await readLimited(res)).toString('utf8'))?.image || ''), 'base64')
    : await readLimited(res)
  return { png: raw, model: 'local-json' }
}

async function fromLocalOpenAI(prompt: string, base: string, headers: Record<string, string>): Promise<{ png: Buffer; model: string }> {
  const res = await postJson(joinPath(base, '/v1/images/generations'), headers, { prompt, size: '512x512', n: 1, response_format: 'b64_json' }, 120_000)
  const buf = await readLimited(res)
  if (!res.ok) throw new Error(errorDetail(res.status, buf.toString('utf8').slice(0, 400)))
  const data = JSON.parse(buf.toString('utf8'))?.data?.[0]
  if (data?.b64_json) return { png: Buffer.from(data.b64_json, 'base64'), model: 'local-openai' }
  if (typeof data?.url === 'string') {
    assertNotPaidHost(data.url)
    const img = await imageFetch(data.url, { signal: AbortSignal.timeout(timeoutMs()) })
    const raw = await readLimited(img)
    if (!img.ok || !isImage(raw, img.headers.get('content-type') || '')) throw new Error('local openai-compatible response had no image')
    return { png: raw, model: 'local-openai' }
  }
  throw new Error('local openai-compatible response had no image')
}

function comfyWorkflow(prompt: string, ckpt: string) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 1e9), steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'fraymus', images: ['8', 0] } }
  }
}

async function fromComfy(prompt: string, base: string, headers: Record<string, string>): Promise<{ png: Buffer; model: string }> {
  const ckpt = process.env.COMFY_CHECKPOINT?.trim() || 'sd_xl_base_1.0.safetensors'
  const res = await postJson(joinPath(base, '/prompt'), headers, { prompt: comfyWorkflow(prompt, ckpt) }, 30_000)
  const createdBuf = await readLimited(res)
  if (!res.ok) throw new Error(errorDetail(res.status, createdBuf.toString('utf8').slice(0, 400)))
  const created = JSON.parse(createdBuf.toString('utf8'))
  if (!created.prompt_id) throw new Error(clip('comfy did not return prompt_id'))
  let image: { filename: string; subfolder?: string; type?: string } | undefined
  for (let i = 0; i < 60 && !image; i++) {
    if (i) await sleep(1000)
    const histRes = await imageFetch(`${base.replace(/\/$/, '')}/history/${created.prompt_id}`, { headers, signal: AbortSignal.timeout(20_000) })
    const histBuf = await readLimited(histRes)
    if (!histRes.ok) throw new Error(errorDetail(histRes.status, histBuf.toString('utf8').slice(0, 300)))
    const hist = JSON.parse(histBuf.toString('utf8'))
    const outputs = hist?.[created.prompt_id]?.outputs || {}
    for (const node of Object.values(outputs) as any[]) {
      if (node?.images?.[0]?.filename) { image = node.images[0]; break }
    }
  }
  if (!image) throw new Error('comfy history had no image')
  const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' })
  const view = await imageFetch(`${base.replace(/\/$/, '')}/view?${q}`, { signal: AbortSignal.timeout(timeoutMs()) })
  const raw = await readLimited(view)
  if (!view.ok || !isImage(raw, view.headers.get('content-type') || '')) throw new Error('comfy view was not an image')
  return { png: raw, model: ckpt }
}

async function fromOpenAI(prompt: string): Promise<{ png: Buffer; model: string }> {
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1'
  const base = (process.env.OPENAI_IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const body: Record<string, unknown> = { model, prompt, size: '1024x1024', n: 1 }
  if (model.startsWith('dall-e')) body.response_format = 'b64_json'
  const res = await postJson(`${base}/images/generations`, {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  }, body, 120_000)
  const buf = await readLimited(res)
  if (!res.ok) throw new Error(errorDetail(res.status, buf.toString('utf8').slice(0, 500)))
  const data = JSON.parse(buf.toString('utf8'))?.data?.[0]
  if (data?.b64_json) return { png: Buffer.from(data.b64_json, 'base64'), model }
  if (typeof data?.url === 'string') {
    const img = await imageFetch(data.url, { signal: AbortSignal.timeout(timeoutMs()) })
    const raw = await readLimited(img)
    if (!img.ok || !isImage(raw, img.headers.get('content-type') || '')) throw new Error('openai response had no image')
    return { png: raw, model }
  }
  throw new Error('openai response had no image')
}

async function fromReplicate(prompt: string): Promise<{ png: Buffer; model: string }> {
  const model = process.env.REPLICATE_IMAGE_MODEL?.trim() || 'black-forest-labs/flux-schnell'
  const token = process.env.REPLICATE_API_TOKEN || ''
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' }
  const res = await postJson(`https://api.replicate.com/v1/models/${model}/predictions`, headers, { input: { prompt } })
  let pred: any = JSON.parse((await readLimited(res)).toString('utf8'))
  if (!res.ok) throw new Error(errorDetail(res.status, JSON.stringify(pred).slice(0, 400)))
  for (let i = 0; i < 30 && pred?.urls?.get && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
    await sleep(1000)
    const poll = await imageFetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    const text = (await readLimited(poll)).toString('utf8')
    pred = JSON.parse(text)
    if (!poll.ok) throw new Error(errorDetail(poll.status, text.slice(0, 300)))
  }
  if (pred.status !== 'succeeded') throw new Error(clip(`replicate ${pred.status || 'error'}: ${pred.error || pred.detail || ''}`))
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output
  if (typeof out !== 'string') throw new Error('replicate returned no image')
  const img = await imageFetch(out, { signal: AbortSignal.timeout(timeoutMs()) })
  const raw = await readLimited(img)
  if (!img.ok || !isImage(raw, img.headers.get('content-type') || '')) throw new Error('replicate output was not an image')
  return { png: raw, model }
}

function done(engine: string, model: string, costMode: CostMode, png: Buffer, attempts: ImageAttempt[], watermark = false, width?: number, height?: number): ImageResult {
  return { png, mocked: false, engine, model, costMode, width, height, watermark, attempts }
}

async function callProvider(name: string, prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  if (name === 'pollinations') return pollinations(prompt, attempts)
  const t0 = Date.now()
  try {
    let out: { png: Buffer; model: string }
    let cost: CostMode = 'free'
    let engine = name
    if (name === 'huggingface') { out = await fromHuggingFace(prompt); engine = 'hf-fal'; cost = 'included-credit' }
    else if (name === 'gemini') { out = await fromGemini(prompt); cost = 'paid'; engine = 'gemini' }
    else if (name === 'local') { out = await fromLocal(prompt); engine = 'local' }
    else if (name === 'openai') { out = await fromOpenAI(prompt); cost = 'paid'; engine = 'openai' }
    else if (name === 'replicate') { out = await fromReplicate(prompt); cost = 'paid'; engine = 'replicate' }
    else throw new Error('unknown provider')
    const norm = await normalizePng(out.png)
    attempts.push({ provider: name, status: 'succeeded', durationMs: Date.now() - t0 })
    return done(engine, out.model, cost, norm.png, attempts, false, norm.width, norm.height)
  } catch (e: any) {
    const reason = clip(e?.message || String(e))
    console.warn(`[image] ${name} failed: ${reason}`)
    attempts.push({ provider: name, status: reason, durationMs: Date.now() - t0 })
    return null
  }
}

async function placeholder(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult> {
  const t0 = Date.now()
  const svg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#e5e7eb"/><rect x="64" y="64" width="896" height="896" fill="none" stroke="#111" stroke-width="8" stroke-dasharray="16 12"/><text x="50%" y="470" text-anchor="middle" fill="#111" font-family="monospace" font-size="36">OFFLINE PLACEHOLDER</text><text x="50%" y="530" text-anchor="middle" fill="#333" font-family="monospace" font-size="22">not a generated photo</text><text x="50%" y="620" text-anchor="middle" fill="#111" font-family="monospace" font-size="18">${escapeXml(prompt.slice(0, 60))}</text></svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  attempts.push({ provider: 'placeholder', status: 'offline-placeholder', durationMs: Date.now() - t0 })
  return {
    png, mocked: true, engine: 'offline-placeholder', model: 'offline-placeholder', costMode: 'offline',
    width: 1024, height: 1024, watermark: false, attempts
  }
}

export function failureMessage(attempts: ImageAttempt[], strict = false): string {
  const why = attempts.filter((a) => a.provider !== 'placeholder').map((a) => `${a.provider} (${a.status})`).join('; ')
  const base = `Image generation failed. Tried ${why || 'no provider'}.`
  return strict ? `${base} This run should be refunded.` : base
}

export function resetImageGenForTests() {
  pollCache.clear()
  pollTail = Promise.resolve()
  fetchOverride = null
  const path = budgetPath || `${process.env.DATA_DIR || './data'}/image-budget.sqlite`
  if (budget) { try { budget.close() } catch { /* already closed */ } budget = null }
  budgetPath = ''
  budgetOpen = null
  try { rmSync(path, { force: true }) } catch { /* no budget file yet */ }
}

export async function runFlux(prompt: string, opts: { strict?: boolean } = {}): Promise<ImageResult> {
  const strict = !!opts.strict
  const text = String(prompt || '').trim()
  if (!text) throw new Error('prompt required')
  const names = listedImageProviders({ strict })
  const attempts: ImageAttempt[] = []
  let called = false
  for (const name of names) {
    if (!KNOWN.has(name)) {
      attempts.push({ provider: name, status: 'unknown provider', durationMs: 0 })
      continue
    }
    if (name === 'placeholder') {
      if (!strict) return placeholder(text, attempts)
      continue
    }
    if (!configured(name)) {
      attempts.push({ provider: name, status: skipReason(name), durationMs: 0 })
      continue
    }
    called = true
    const result = await callProvider(name, text, attempts)
    if (result) return result
  }
  if (!called && !strict) return placeholder(text, attempts)
  throw new Error(failureMessage(attempts, strict))
}
