// Free-first image generation. runFlux is the only image entry point.
// Default chain: Hugging Face fal-ai FLUX.1-schnell (included PRO credits, local USD cap)
// -> Pollinations Classic anonymous (watermark, one at a time)
// -> a labelled offline placeholder.
// Strict/buyer runs use BUYER_IMAGE_PROVIDERS (default hf-fal) and fail instead of a placeholder.
// OpenAI Images and Replicate are not image providers. Gemini and the local worker stay off
// unless the owner names them and sets their confirmation flags.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

export type CostMode = 'included-credit' | 'free' | 'offline'
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

const FAL_IDS: Record<string, string> = {
  'black-forest-labs/FLUX.1-schnell': 'fal-ai/flux/schnell',
  'black-forest-labs/FLUX.1-dev': 'fal-ai/flux/dev'
}
const HF_W = 1024
const HF_H = 1024
const PAID_NAMES = new Set(['openai', 'replicate'])

let fetchOverride: typeof fetch | null = null
let budget: any = null
let budgetPath = ''
let budgetOpen: Promise<void> | null = null
let budgetGate: Promise<void> = Promise.resolve()
const pollCache = new Map<string, Buffer>()
let pollTail: Promise<void> = Promise.resolve()
let pollLastStarted = 0

export function setImageFetchForTests(fn: typeof fetch | null) {
  fetchOverride = fn
}
export function imageFetch(input: RequestInfo | URL, init?: RequestInit) {
  return (fetchOverride || globalThis.fetch)(input, init)
}

function truthy(v: string | undefined) {
  return !!v && !['0', 'off', 'false', 'no'].includes(v.trim().toLowerCase())
}
function num(v: string | undefined, fallback: number) {
  if (v == null || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function timeoutMs() { return Math.max(1000, num(process.env.IMAGE_GENERATION_TIMEOUT_MS, 120_000)) }
function maxBytes() { return Math.max(1024, num(process.env.IMAGE_DOWNLOAD_MAX_BYTES, 25_000_000)) }
function monthlyCap() { return Math.max(0, num(process.env.IMAGE_MONTHLY_CREDIT_CAP_USD, 1.5)) }
function pricePerMp() { return Math.max(0, num(process.env.HF_IMAGE_PRICE_PER_MEGAPIXEL_USD, 0.003)) }
function pollGapMs() { return Math.max(0, num(process.env.POLLINATIONS_MIN_INTERVAL_MS, 46_000)) }
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7) }
function modelId() { return process.env.HF_FLUX_MODEL || 'black-forest-labs/FLUX.1-schnell' }
function estimateUsd(w: number, h: number) { return (w * h / 1_000_000) * pricePerMp() }
function overrunAllowed() { return truthy(process.env.IMAGE_ALLOW_PAID_OVERRUN) }

export function imageProviderPlan(opts: { strict?: boolean } = {}): string[] {
  const raw = opts.strict
    ? (process.env.BUYER_IMAGE_PROVIDERS || 'hf-fal')
    : (process.env.IMAGE_PROVIDERS || 'hf-fal,pollinations,placeholder')
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((name) => {
    if (!name || PAID_NAMES.has(name)) return false
    if (opts.strict && name === 'placeholder') return false
    return true
  })
}

function hfEnabled() {
  const flag = process.env.HF_IMAGE_ENABLED
  if (flag != null && flag.trim() !== '' && !truthy(flag)) return false
  return !!process.env.HF_TOKEN
}

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

/** Sum of estimates for in-flight and succeeded HF calls this UTC month. Failed rows stay for the log and do not count. */
export async function hfReservedUsd(): Promise<number> {
  const db = await budgetDb()
  const row = db.prepare(`select coalesce(sum(estimated_usd), 0) as spent from image_calls where month = ? and status in ('reserved', 'succeeded')`).get(monthKey()) as { spent: number }
  return Number(row?.spent) || 0
}

export async function imageCalls(): Promise<any[]> {
  const db = await budgetDb()
  return db.prepare('select id, month, provider, status, estimated_usd, actual_usd, width, height from image_calls order by id').all()
}

async function reserveHf(estimate: number): Promise<{ id: number } | { blocked: true }> {
  return exclusive(() => reserveHfBody(estimate))
}

async function reserveHfBody(estimate: number): Promise<{ id: number } | { blocked: true }> {
  const db = await budgetDb()
  const month = monthKey()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`select coalesce(sum(estimated_usd), 0) as spent from image_calls where month = ? and status in ('reserved', 'succeeded')`).get(month) as { spent: number }
    const spent = Number(row?.spent) || 0
    if (!overrunAllowed() && spent + estimate > monthlyCap() + 1e-9) {
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
}

async function finishHf(id: number, width: number, height: number) {
  const db = await budgetDb()
  const actual = estimateUsd(width, height)
  db.prepare(`update image_calls set status = 'succeeded', actual_usd = ?, width = ?, height = ? where id = ?`).run(actual, width, height, id)
}

async function releaseHf(id: number) {
  const db = await budgetDb()
  db.prepare(`update image_calls set status = 'failed', actual_usd = 0 where id = ?`).run(id)
}

function stopHf(status: number) {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500
}

async function readLimited(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes()) throw Object.assign(new Error(`image too large (${declared} bytes)`), { kind: 'rejected' })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes()) throw Object.assign(new Error(`image too large (${buf.length} bytes)`), { kind: 'rejected' })
  return buf
}

async function normalizePng(raw: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  let meta: sharp.Metadata
  try { meta = await sharp(raw, { limitInputPixels: 4096 * 4096 }).metadata() } catch {
    throw Object.assign(new Error('invalid image bytes'), { kind: 'rejected' })
  }
  const width = meta.width || 0
  const height = meta.height || 0
  if (!width || !height || width * height > 4096 * 4096) throw Object.assign(new Error('decoded image too large'), { kind: 'rejected' })
  const png = await sharp(raw, { limitInputPixels: 4096 * 4096 }).png().toBuffer()
  if (png.length > maxBytes()) throw Object.assign(new Error('normalized png too large'), { kind: 'rejected' })
  return { png, width, height }
}

function hfNames(): string[] {
  if (process.env.HF_FLUX_URL) return ['url']
  const names = (process.env.HF_FLUX_PROVIDER || 'fal-ai').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return names.filter((n) => n === 'fal-ai' || n === 'nscale' || n === 'url')
}

async function hfOnce(name: string, prompt: string): Promise<Buffer> {
  const token = process.env.HF_TOKEN || ''
  const model = modelId()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const signal = AbortSignal.timeout(timeoutMs())
  const steps = /schnell/i.test(model) ? 4 : 28
  if (name === 'nscale') {
    const r = await imageFetch('https://router.huggingface.co/nscale/v1/images/generations', {
      signal, method: 'POST', headers,
      body: JSON.stringify({ model, prompt, size: `${HF_W}x${HF_H}`, response_format: 'b64_json' })
    })
    const text = await r.text()
    if (!r.ok) throw Object.assign(new Error(`${r.status}: ${text.slice(0, 160)}`), { status: r.status })
    let b64 = ''
    try { b64 = JSON.parse(text)?.data?.[0]?.b64_json || '' } catch { throw Object.assign(new Error('invalid json'), { kind: 'rejected' }) }
    if (!b64) throw Object.assign(new Error('invalid json'), { kind: 'rejected' })
    return Buffer.from(b64, 'base64')
  }
  if (name === 'fal-ai') {
    const id = FAL_IDS[model]
    if (!id) throw new Error(`no fal-ai mapping for ${model}`)
    const r = await imageFetch(`https://router.huggingface.co/fal-ai/${id}`, {
      signal, method: 'POST', headers,
      body: JSON.stringify({ prompt, num_inference_steps: steps, image_size: { width: HF_W, height: HF_H } })
    })
    const text = await r.text()
    if (!r.ok) throw Object.assign(new Error(`${r.status}: ${text.slice(0, 160)}`), { status: r.status })
    let imgUrl = ''
    try { imgUrl = JSON.parse(text)?.images?.[0]?.url || '' } catch { throw Object.assign(new Error('invalid json'), { kind: 'rejected' }) }
    if (!imgUrl) throw Object.assign(new Error('invalid json'), { kind: 'rejected' })
    const ir = await imageFetch(imgUrl, { signal })
    if (!ir.ok) throw Object.assign(new Error(`image download ${ir.status}`), { status: ir.status })
    return readLimited(ir)
  }
  const url = process.env.HF_FLUX_URL || `https://router.huggingface.co/hf-inference/models/${model}`
  const r = await imageFetch(url, {
    signal, method: 'POST', headers,
    body: JSON.stringify({ inputs: prompt, parameters: { num_inference_steps: steps, guidance_scale: 0 } })
  })
  if (!r.ok) throw Object.assign(new Error(`${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status })
  return readLimited(r)
}

async function tryHf(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  const t0 = Date.now()
  if (!hfEnabled()) {
    attempts.push({ provider: 'hf-fal', status: process.env.HF_TOKEN ? 'disabled' : 'no-token', durationMs: 0 })
    return null
  }
  const estimate = estimateUsd(HF_W, HF_H)
  const slot = await reserveHf(estimate)
  if ('blocked' in slot) {
    attempts.push({ provider: 'hf-fal', status: 'cap-exceeded', durationMs: Date.now() - t0 })
    return null
  }
  const names = hfNames()
  let last = 'no hf provider'
  let stop = false
  for (const name of names) {
    if (stop) break
    try {
      const raw = await hfOnce(name, prompt)
      const norm = await normalizePng(raw)
      await finishHf(slot.id, norm.width, norm.height)
      attempts.push({ provider: 'hf-fal', status: 'succeeded', durationMs: Date.now() - t0 })
      return {
        png: norm.png, mocked: false, engine: 'hf-fal', model: modelId(), costMode: 'included-credit',
        width: norm.width, height: norm.height, watermark: false, attempts
      }
    } catch (e: any) {
      last = e?.message || String(e)
      const status = Number(e?.status) || 0
      if (stopHf(status)) stop = true
    }
  }
  await releaseHf(slot.id)
  attempts.push({ provider: 'hf-fal', status: last.slice(0, 160), durationMs: Date.now() - t0 })
  return null
}

function pollCacheKey(prompt: string) { return `${prompt.trim()}\n768x768\nsafe` }

async function fetchPollinations(prompt: string): Promise<Buffer> {
  const seed = Math.floor(Math.random() * 1_000_000_000) + 1
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&safe=true&seed=${seed}`
  let last = 'pollinations failed'
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await imageFetch(url, {
      signal: AbortSignal.timeout(timeoutMs()),
      headers: { Accept: 'image/*', 'User-Agent': 'fraymus-fly-io/image-gen' }
    })
    if (r.status === 402 || r.status === 429 || r.status >= 500) {
      last = `${r.status}`
      if (attempt < 2) {
        const retryAfter = Number(r.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000
        await new Promise((res) => setTimeout(res, Math.min(wait, timeoutMs() / 4)))
        continue
      }
      throw new Error(last)
    }
    if (!r.ok) throw new Error(`${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (!ct.startsWith('image/')) throw Object.assign(new Error(`content-type ${ct || 'missing'}`), { kind: 'rejected' })
    const buf = await readLimited(r)
    return (await normalizePng(buf)).png
  }
  throw new Error(last)
}

function pollinations(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  const key = pollCacheKey(prompt)
  const hit = pollCache.get(key)
  if (hit) {
    attempts.push({ provider: 'pollinations', status: 'cache', durationMs: 0 })
    return Promise.resolve(pollResult(hit, attempts))
  }
  const job = pollTail.then(async () => {
    const again = pollCache.get(key)
    if (again) {
      attempts.push({ provider: 'pollinations', status: 'cache', durationMs: 0 })
      return pollResult(again, attempts)
    }
    const wait = pollLastStarted ? Math.max(0, pollLastStarted + pollGapMs() - Date.now()) : 0
    if (wait) await new Promise((res) => setTimeout(res, wait))
    const t0 = Date.now()
    pollLastStarted = Date.now()
    try {
      const png = await fetchPollinations(prompt)
      pollCache.set(key, png)
      if (pollCache.size > 64) pollCache.delete(pollCache.keys().next().value as string)
      attempts.push({ provider: 'pollinations', status: 'succeeded', durationMs: Date.now() - t0 })
      return pollResult(png, attempts)
    } catch (e: any) {
      attempts.push({ provider: 'pollinations', status: String(e?.message || e).slice(0, 160), durationMs: Date.now() - t0 })
      return null
    }
  })
  pollTail = job.then(() => {}, () => {})
  return job
}

function pollResult(png: Buffer, attempts: ImageAttempt[]): ImageResult {
  return {
    png, mocked: false, engine: 'pollinations-classic', model: 'pollinations-classic', costMode: 'free',
    watermark: true, attempts
  }
}

async function tryGemini(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  const t0 = Date.now()
  const key = process.env.GEMINI_API_KEY
  const included = process.env.GEMINI_IMAGE_INCLUDED_CREDIT_ONLY === 'true'
  const confirmed = process.env.GEMINI_IMAGE_BILLING_CONFIRMED === 'true'
  if (!key || !included || !confirmed) {
    attempts.push({ provider: 'gemini', status: 'disabled', durationMs: 0 })
    return null
  }
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1'
  const r = await imageFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs()),
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
  })
  const text = await r.text()
  if (!r.ok || /billing|quota|RESOURCE_EXHAUSTED/i.test(text)) {
    attempts.push({ provider: 'gemini', status: `http-${r.status}`, durationMs: Date.now() - t0 })
    return null
  }
  try {
    const parts = JSON.parse(text)?.candidates?.[0]?.content?.parts || []
    const data = parts.map((p: any) => p.inlineData?.data || p.inline_data?.data).find(Boolean) || ''
    if (!data) throw new Error('no-image')
    const norm = await normalizePng(Buffer.from(data, 'base64'))
    attempts.push({ provider: 'gemini', status: 'succeeded', durationMs: Date.now() - t0 })
    return {
      png: norm.png, mocked: false, engine: 'gemini', model, costMode: 'included-credit',
      width: norm.width, height: norm.height, watermark: false, attempts
    }
  } catch (e: any) {
    attempts.push({ provider: 'gemini', status: String(e?.message || 'no-image').slice(0, 160), durationMs: Date.now() - t0 })
    return null
  }
}

/** Private ComfyUI bridge. Never calls Hugging Face, Pollinations, OpenAI, or Replicate. */
export async function fetchLocalImage(prompt: string, width = 768, height = 768): Promise<{ png: Buffer; width: number; height: number } | { offline: true }> {
  const endpoint = process.env.LOCAL_IMAGE_ENDPOINT
  if (!endpoint) return { offline: true }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'image/png, image/jpeg, application/json' }
  if (process.env.LOCAL_IMAGE_TOKEN) headers.Authorization = `Bearer ${process.env.LOCAL_IMAGE_TOKEN}`
  try {
    const r = await imageFetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs()), headers,
      body: JSON.stringify({ prompt, width, height })
    })
    if (!r.ok) return { offline: true }
    const ct = r.headers.get('content-type') || ''
    const raw = ct.includes('json')
      ? Buffer.from(String(JSON.parse(await r.text())?.image || ''), 'base64')
      : await readLimited(r)
    if (!raw.length) return { offline: true }
    const norm = await normalizePng(raw)
    return { png: norm.png, width: norm.width, height: norm.height }
  } catch (e: any) {
    console.warn('[image] local worker offline:', String(e?.message || e).slice(0, 120))
    return { offline: true }
  }
}

async function tryLocal(prompt: string, attempts: ImageAttempt[]): Promise<ImageResult | null> {
  const t0 = Date.now()
  const got = await fetchLocalImage(prompt, 768, 768)
  if ('offline' in got) {
    attempts.push({ provider: 'local', status: 'Local image worker offline', durationMs: Date.now() - t0 })
    return null
  }
  attempts.push({ provider: 'local', status: 'succeeded', durationMs: Date.now() - t0 })
  return {
    png: got.png, mocked: false, engine: 'local-comfyui', model: 'local-comfyui', costMode: 'free',
    width: got.width, height: got.height, watermark: false, attempts
  }
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string))
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

function closedMessage(attempts: ImageAttempt[]) {
  const why = attempts.map((a) => `${a.provider}: ${a.status}`).join(' | ').slice(0, 300)
  return `Paid run stopped: no real image was produced (${why || 'no provider'}). Not using a placeholder or a paid API. This run should be refunded.`
}

export function resetImageGenForTests() {
  pollCache.clear()
  pollLastStarted = 0
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
  const plan = imageProviderPlan({ strict })
  const attempts: ImageAttempt[] = []
  if (!plan.length) throw new Error(closedMessage(attempts))
  for (const name of plan) {
    let result: ImageResult | null = null
    if (name === 'hf-fal') result = await tryHf(prompt, attempts)
    else if (name === 'pollinations') result = await pollinations(prompt, attempts)
    else if (name === 'gemini') result = await tryGemini(prompt, attempts)
    else if (name === 'local') result = await tryLocal(prompt, attempts)
    else if (name === 'placeholder') result = await placeholder(prompt, attempts)
    else attempts.push({ provider: name, status: 'unknown', durationMs: 0 })
    if (result) return result
  }
  if (strict || !plan.includes('placeholder')) throw new Error(closedMessage(attempts))
  return placeholder(prompt, attempts)
}
