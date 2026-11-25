// HTTP client for fraymus-video-studio. STUDIO_URL + STUDIO_TOKEN stay in this process.
// No STUDIO_URL means demo mode: jobs advance locally and never leave the machine.
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ANIME_MV, buildStudioBody, type MvInput } from './contract'

const FILE_CAP = 512 * 1024 * 1024

/** Plain HTTP is only for a studio on this machine or a private network (Fly .internal included). */
export function studioUrlError(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'STUDIO_URL is not a valid URL.' }
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol !== 'http:') return 'STUDIO_URL must be an http or https URL.'
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === '::1') return null
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 127 || a === 10 || a === 0) return null
    if (a === 192 && b === 168) return null
    if (a === 172 && b >= 16 && b <= 31) return null
    if (a === 169 && b === 254) return null
  }
  return 'STUDIO_URL must use https unless it is a loopback, private, or .internal address.'
}
const MOCK_SHOTS = 3

export class StudioError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

export type StudioMode = 'mock' | 'live'
export function studioConfig(): { mode: StudioMode; url: string; token: string } {
  const url = (process.env.STUDIO_URL || '').trim().replace(/\/$/, '')
  const token = (process.env.STUDIO_TOKEN || '').trim()
  if (!url) return { mode: 'mock', url: '', token: '' }
  return { mode: 'live', url, token }
}

export type StudioStatus = {
  mode: StudioMode
  reachable: boolean
  recipe: string
  recipeReady: boolean
  message: string
}

export type StudioSnapshot = {
  status: string
  stage: string
  progress: number
  shot: number | null
  shots: number | null
  files: string[]
  error?: string
}

const scrub = (s: string) => {
  const t = (process.env.STUDIO_TOKEN || '').trim()
  return t ? s.split(t).join('[token]') : s
}

async function studioFetch(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  const cfg = studioConfig()
  if (cfg.mode !== 'live') throw new StudioError('The video studio is not configured.', 503)
  if (!cfg.token) throw new StudioError('STUDIO_URL is set but STUDIO_TOKEN is empty, so the studio cannot be called.', 503)
  const urlError = studioUrlError(cfg.url)
  if (urlError) throw new StudioError(urlError, 503)
  let res: Response
  try {
    res = await fetch(cfg.url + path, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers as Record<string, string> || {}) }
    })
  } catch {
    throw new StudioError('The video studio is not responding.', 503)
  }
  if (res.status >= 300 && res.status < 400) throw new StudioError('The video studio returned a redirect, which this app will not follow.', 502)
  return res
}

async function errorText(res: Response) {
  const raw = await res.text().catch(() => '')
  let msg = raw.slice(0, 500)
  try { const j = JSON.parse(raw); if (j?.error) msg = String(j.error) } catch { /* not json */ }
  if (res.status === 401) msg = 'The video studio refused the token.'
  return scrub(msg || `Studio HTTP ${res.status}`)
}

function progressOf(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  const p = n > 1 ? n / 100 : n
  return Math.max(0, Math.min(1, p))
}
function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
export function normalizeSnapshot(st: any): StudioSnapshot {
  const stage = String(st?.stage || st?.status || '')
  let shot = num(st?.shot ?? st?.current_shot ?? st?.shot_index)
  let shots = num(st?.shots ?? st?.shot_count ?? st?.total_shots)
  const parsed = /shot\s+(\d+)\s*(?:of|\/)\s*(\d+)/i.exec(stage)
  if (shot == null && parsed) shot = Number(parsed[1])
  if (shots == null && parsed) shots = Number(parsed[2])
  const rawFiles = st?.files || st?.result?.files || []
  const files = (Array.isArray(rawFiles) ? rawFiles : []).map((f: any) => {
    const name = String(typeof f === 'string' ? f : f?.name || '').split(/[/\\]/).pop() || ''
    return /^[\w][\w.\-]*$/.test(name) ? name : ''
  }).filter(Boolean)
  const error = st?.error ? scrub(String(st.error)).slice(0, 500) : undefined
  return { status: String(st?.status || 'queued'), stage, progress: progressOf(st?.progress), shot, shots, files, error }
}

export async function ping(): Promise<StudioStatus> {
  const recipe = ANIME_MV.recipe
  const cfg = studioConfig()
  if (cfg.mode === 'mock') {
    return { mode: 'mock', reachable: true, recipe, recipeReady: true, message: 'STUDIO_URL is not set. Make runs in demo mode and produces a short local sample.' }
  }
  if (!cfg.token) {
    return { mode: 'live', reachable: false, recipe, recipeReady: false, message: 'STUDIO_URL is set but STUDIO_TOKEN is empty, so the studio cannot be called.' }
  }
  try {
    const res = await studioFetch('/health', {}, 2500)
    if (!res.ok) return { mode: 'live', reachable: false, recipe, recipeReady: false, message: 'The video studio is not responding.' }
    const body: any = await res.json().catch(() => ({}))
    const recipes = Array.isArray(body?.recipes) ? body.recipes.map(String) : []
    const recipeReady = recipes.includes(recipe)
    return {
      mode: 'live', reachable: true, recipe, recipeReady,
      message: recipeReady ? 'Studio connected.' : 'The studio is up, but the anime-mv recipe is not listed yet.'
    }
  } catch (e: any) {
    return { mode: 'live', reachable: false, recipe, recipeReady: false, message: e?.message || 'The video studio is not responding.' }
  }
}

export async function submit(input: MvInput & { song: Buffer; songExt: string; image?: Buffer | null; imageExt?: string | null }): Promise<{ id: string }> {
  const cfg = studioConfig()
  if (cfg.mode === 'mock') return { id: mockCreate(input) }
  const res = await studioFetch('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildStudioBody(input))
  }, 120_000)
  if (!res.ok) throw new StudioError(await errorText(res), res.status >= 500 ? 502 : res.status)
  const body: any = await res.json().catch(() => null)
  const id = String(body?.id || '')
  if (!/^[a-f0-9]{12}$/.test(id)) throw new StudioError('The studio did not return a job id.', 502)
  return { id }
}

export async function snapshot(studioId: string): Promise<StudioSnapshot> {
  if (studioConfig().mode === 'mock') return mockSnapshot(studioId)
  const res = await studioFetch(`/jobs/${encodeURIComponent(studioId)}`, {}, 15000)
  if (res.status === 404) throw new StudioError('The studio has no record of this job.', 404)
  if (!res.ok) throw new StudioError(await errorText(res), res.status >= 500 ? 502 : res.status)
  return normalizeSnapshot(await res.json().catch(() => ({})))
}

export async function pullFile(studioId: string, name: string, dest: string): Promise<number> {
  if (!/^[\w][\w.\-]*$/.test(name)) throw new StudioError('Bad file name', 400)
  if (studioConfig().mode === 'mock') return mockPull(studioId, name, dest)
  const res = await studioFetch(`/jobs/${encodeURIComponent(studioId)}/files/${encodeURIComponent(name)}`, {}, 180_000)
  if (!res.ok || !res.body) throw new StudioError(res.ok ? 'The studio returned an empty file.' : await errorText(res), res.ok ? 502 : 502)
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true })
  let n = 0
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length
      if (n > FILE_CAP) cb(new Error('The studio file is larger than 512 MB'))
      else cb(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body as any), cap, createWriteStream(dest))
  } catch (e) {
    try { unlinkSync(dest) } catch { /* partial */ }
    throw new StudioError(scrub(String((e as any)?.message || e)), 502)
  }
  return statSync(dest).size
}

export async function removeRemote(studioId: string) {
  if (!studioId) return
  if (studioConfig().mode === 'mock') { mockJobs.delete(studioId); return }
  const res = await studioFetch(`/jobs/${encodeURIComponent(studioId)}`, { method: 'DELETE' }, 8000)
  if (res.ok || res.status === 404) { await res.body?.cancel().catch(() => {}); return }
  throw new StudioError(await errorText(res), res.status >= 500 ? 502 : res.status)
}

// Redo is not part of the studio's base API. Try the two likely paths; a 404/405 means it is not offered.
export async function redoShot(studioId: string, shot: number): Promise<{ supported: boolean; message?: string }> {
  if (studioConfig().mode === 'mock') return mockRedo(studioId, shot)
  const tries = [
    `/jobs/${encodeURIComponent(studioId)}/shots/${shot}/redo`,
    `/jobs/${encodeURIComponent(studioId)}/redo`
  ]
  for (const path of tries) {
    const res = await studioFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shot }) }, 20000)
    if (res.ok) { await res.body?.cancel().catch(() => {}); return { supported: true } }
    if (res.status !== 404 && res.status !== 405) throw new StudioError(await errorText(res), res.status >= 500 ? 502 : res.status)
    await res.body?.cancel().catch(() => {})
  }
  return { supported: false, message: 'This studio does not offer single-shot redo yet.' }
}

// ---------- demo mode ----------
type MockJob = { input: MvInput; cursor: number; phase: 'running' | 'done'; files: Record<string, Buffer> }
const mockJobs = new Map<string, MockJob>()
let sampleMp4: Buffer | null = null
let samplePng: Buffer | null = null
const mp4 = () => sampleMp4 || (sampleMp4 = readFileSync(new URL('./mock-sample.mp4', import.meta.url)))
const contactPng = () => samplePng || (samplePng = readFileSync(new URL('./mock-contact.png', import.meta.url)))

function mockFiles(input: MvInput): Record<string, Buffer> {
  const lines = Array.isArray(input.storyline) ? input.storyline : [input.storyline]
  const sheet = Buffer.from(`# Shot list\n\nCharacter: ${input.character || '(picture)'}\nStyle: ${input.style}\nAspect: ${input.aspect}\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nDemo mode: STUDIO_URL is not set, so this is a local sample and not a rendered music video.\n`)
  const files: Record<string, Buffer> = {
    [ANIME_MV.outputs.master]: mp4(),
    [ANIME_MV.outputs.phone]: mp4(),
    [ANIME_MV.outputs.contact]: contactPng(),
    [ANIME_MV.outputs.shotlist]: sheet
  }
  if (input.lyrics) files[ANIME_MV.outputs.lyrics] = mp4()
  return files
}
function mockCreate(input: MvInput): string {
  const id = randomBytes(6).toString('hex')
  mockJobs.set(id, { input, cursor: 0, phase: 'running', files: mockFiles(input) })
  return id
}
function mockSnapshot(id: string): StudioSnapshot {
  const j = mockJobs.get(id)
  if (!j) throw new StudioError('This demo job is no longer in memory. Make it again.', 404)
  if (j.phase === 'done') return mockDone(j)
  j.cursor += 1
  if (j.cursor >= MOCK_SHOTS) { j.phase = 'done'; return mockDone(j) }
  return { status: 'running', stage: 'rendering', progress: j.cursor / MOCK_SHOTS, shot: j.cursor, shots: MOCK_SHOTS, files: [] }
}
function mockDone(j: MockJob): StudioSnapshot {
  return { status: 'done', stage: 'done', progress: 1, shot: MOCK_SHOTS, shots: MOCK_SHOTS, files: Object.keys(j.files) }
}
function mockPull(id: string, name: string, dest: string) {
  const buf = mockJobs.get(id)?.files[name]
  if (!buf) throw new StudioError('The demo job has no file named ' + name, 404)
  mkdirSync(dest.slice(0, dest.lastIndexOf('/')), { recursive: true })
  writeFileSync(dest, buf)
  return buf.length
}
function mockRedo(id: string, shot: number) {
  const j = mockJobs.get(id)
  if (!j) throw new StudioError('This demo job is no longer in memory. Make it again.', 404)
  if (!Number.isInteger(shot) || shot < 1 || shot > MOCK_SHOTS) throw new StudioError(`Shot must be between 1 and ${MOCK_SHOTS}.`, 400)
  j.phase = 'running'
  j.cursor = shot - 1
  return { supported: true }
}
