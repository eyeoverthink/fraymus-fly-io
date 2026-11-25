// Music Video Maker. The browser talks only to these routes. Rendering happens in
// fraymus-video-studio (STUDIO_URL + STUDIO_TOKEN, server-side). With no STUDIO_URL the
// same routes run a short local demo so the page can be tried and tested.
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { db, now } from '../agent/db'
import { appendRecord } from '../memory/record'
import { upsertItem } from '../library'
import { ANIME_MV, OUTPUT_LABEL, classifyOutput, storyText, type MvInput } from './contract'
import { ping, pullFile, redoShot, removeRemote, snapshot, studioConfig, submit, type StudioSnapshot } from './client'

const SONG_MAX = 50 * 1024 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
const MAX_OUTPUT_FILES = 8
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
const ACTIVE_PER_USER = 2
const FAIL_LIMIT = 5
const AGENT = 'music-video'
const DATA = () => process.env.DATA_DIR || './data'
const AUDIO_EXT: Record<string, string> = { mp3: '.mp3', wav: '.wav', m4a: '.m4a', aac: '.aac', flac: '.flac', ogg: '.ogg', opus: '.opus' }
const AUDIO_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/ogg': '.ogg', 'audio/opus': '.opus'
}
const IMAGE_EXT: Record<string, string> = { png: '.png', jpg: '.jpg', jpeg: '.jpg', webp: '.webp' }
const IMAGE_MIME: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
const SERVE: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8'
}

db.exec(`create table if not exists mv_jobs(
  id text primary key, user_id text not null, studio_id text, title text, status text not null, stage text,
  progress real, shot integer, shots integer, error text, input text not null, files text, fails integer default 0,
  idem_key text, gen integer default 0, created_at integer, updated_at integer);
create index if not exists idx_mv_user on mv_jobs(user_id, created_at);
create unique index if not exists idx_mv_idem on mv_jobs(user_id, idem_key) where idem_key is not null;`)
for (const sql of ['alter table mv_jobs add column fails integer default 0', 'alter table mv_jobs add column idem_key text', 'alter table mv_jobs add column gen integer default 0']) {
  try { db.exec(sql) } catch { /* column already exists */ }
}

type Row = { id: string; user_id: string; studio_id: string | null; title: string; status: string; stage: string | null; progress: number | null; shot: number | null; shots: number | null; error: string | null; input: string; files: string | null; fails: number | null; idem_key: string | null; gen: number | null; created_at: number; updated_at: number }
const parse = (s: any, d: any = null) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const load = (id: string, userId?: string) => db.prepare(`select * from mv_jobs where id=?${userId ? ' and user_id=?' : ''}`).get(...(userId ? [id, userId] : [id])) as Row | undefined
const fail = (status: number, message: string) => Object.assign(new Error(message), { status })

function save(id: string, f: Record<string, any>) {
  const keys = Object.keys(f)
  db.prepare(`update mv_jobs set ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? where id=?`).run(
    ...keys.map((k) => { const v = f[k]; if (v == null) return null; return typeof v === 'object' ? JSON.stringify(v) : v }), now(), id)
}

const gates = new Map<string, Promise<unknown>>()
function lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = gates.get(id) || Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(() => { if (gates.get(id) === tail) gates.delete(id) }, () => { if (gates.get(id) === tail) gates.delete(id) })
  gates.set(id, tail)
  return run
}

function extOf(name: string, table: Record<string, string>, mime: string, mimeTable: Record<string, string>) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '')
  if (m && table[m[1].toLowerCase()]) return table[m[1].toLowerCase()]
  return mimeTable[(mime || '').toLowerCase()] || ''
}

type Spec = MvInput & { song: Buffer; songExt: string; image: Buffer | null; imageExt: string | null }

async function readForm(req: any): Promise<{ fields: Record<string, string>; files: Record<string, { buf: Buffer; name: string; mime: string }> }> {
  if (typeof req.isMultipart !== 'function' || !req.isMultipart()) throw fail(400, 'Upload the song as a multipart form.')
  const fields: Record<string, string> = {}
  const files: Record<string, { buf: Buffer; name: string; mime: string }> = {}
  let kept = 0
  try {
    for await (const part of req.parts({ limits: { files: 3, fields: 20, fileSize: SONG_MAX } })) {
      if (part.type === 'file' || part.file) {
        const field = String(part.fieldname || '')
        if ((field !== 'song' && field !== 'character_image') || files[field]) { part.file?.resume?.(); continue }
        const buf: Buffer = await part.toBuffer()
        kept += buf.length
        if (kept > SONG_MAX + IMAGE_MAX) throw fail(413, 'The upload is too large.')
        files[field] = { buf, name: String(part.filename || ''), mime: String(part.mimetype || '') }
      } else if (Object.keys(fields).length < 20) fields[part.fieldname] = String(part.value ?? '').slice(0, 20_000)
    }
  } catch (e: any) {
    if (e?.status) throw e
    throw fail(413, 'That file is over 50 MB. Use a shorter mix or a smaller encoding.')
  }
  return { fields, files }
}

function normalize(fields: Record<string, string>, files: Record<string, { buf: Buffer; name: string; mime: string }>): Spec {
  const song = files.song
  if (!song?.buf?.length) throw fail(400, 'A song file is required (mp3, wav, m4a, flac, or ogg, up to 50 MB).')
  if (song.buf.length > SONG_MAX) throw fail(413, 'That song is over 50 MB.')
  const songExt = extOf(song.name, AUDIO_EXT, song.mime, AUDIO_MIME)
  if (!songExt) throw fail(400, 'Upload a song file (mp3, wav, m4a, flac, or ogg).')
  const image = files.character_image?.buf?.length ? files.character_image : null
  let imageExt: string | null = null
  if (image) {
    if (image.buf.length > IMAGE_MAX) throw fail(413, 'The character picture is over 8 MB.')
    imageExt = extOf(image.name, IMAGE_EXT, image.mime, IMAGE_MIME)
    if (!imageExt) throw fail(400, 'The character picture must be a png, jpg, or webp.')
  }
  const character = String(fields.character || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (!character && !image) throw fail(400, 'Describe the character or upload a picture of them.')
  const rawLines = String(fields.storyline || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!rawLines.length) throw fail(400, 'A storyline is required: a short paragraph, or one beat per line.')
  const storyline = rawLines.length === 1 ? rawLines[0].slice(0, 8000) : rawLines.slice(0, 40).map((l) => l.slice(0, 500))
  const consent = /^(1|true|yes|on)$/i.test(String(fields.consent || ''))
  if (!consent) throw fail(400, 'Confirm you have the rights to this song and this character.')
  const aspect = String(fields.aspect || '16:9')
  if (aspect !== '16:9' && aspect !== '9:16') throw fail(400, 'Aspect must be 16:9 or 9:16.')
  const backend = String(fields.backend || 'hf').toLowerCase()
  if (backend !== 'hf' && backend !== 'comfy') throw fail(400, 'Backend must be hf or comfy.')
  const style = (String(fields.style || 'anime').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').slice(0, 40) || 'anime')
  const lyrics = fields.lyrics == null || fields.lyrics === '' ? true : !/^(0|false|no|off)$/i.test(String(fields.lyrics))
  const songBase = (song.name || 'song').replace(/\.[^.]+$/, '').replace(/[^\w .\-]+/g, '').trim().slice(0, 80) || 'song'
  const title = String(fields.title || songBase).replace(/\s+/g, ' ').trim().slice(0, 120) || songBase
  return {
    title, character, storyline, style, aspect, lyrics, backend, songName: song.name || `song${songExt}`,
    characterImageName: image ? (image.name || `character${imageExt}`) : null,
    song: song.buf, songExt, image: image ? image.buf : null, imageExt
  }
}

function metaOf(input: MvInput, id: string) {
  return {
    jobId: id, recipe: ANIME_MV.recipe, character: input.character, storyline: input.storyline, style: input.style,
    aspect: input.aspect, lyrics: input.lyrics, backend: input.backend, songName: input.songName,
    characterImage: input.characterImageName || undefined
  }
}

function present(row: Row, snap?: StudioSnapshot, warning?: string) {
  const input = parse(row.input, {})
  const files = ((parse(row.files, []) as any[]) || []).map((f) => ({
    name: f.name, kind: f.kind, label: f.label, url: f.url, libraryId: f.libraryId || undefined, bytes: f.bytes
  }))
  return {
    id: row.id, title: row.title,
    status: snap?.status || row.status,
    stage: snap?.stage || row.stage || undefined,
    progress: snap ? snap.progress : (row.progress ?? 0),
    shot: snap ? snap.shot : row.shot,
    shots: snap ? snap.shots : row.shots,
    error: warning || snap?.error || row.error || undefined,
    mode: studioConfig().mode,
    input, files,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

async function ingest(row: Row, snap: StudioSnapshot) {
  if (snap.files.length > MAX_OUTPUT_FILES) throw fail(413, `The studio returned ${snap.files.length} files; the limit is ${MAX_OUTPUT_FILES}.`)
  const input = parse(row.input, {}) as MvInput
  const gen = Number(row.gen || 0) + 1
  const saved: any[] = []
  let shotlist = ''
  let total = 0
  for (const name of snap.files) {
    const kind = classifyOutput(name)
    const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase().replace('.', '')
    const rel = `music-video/${row.id}/${name}`
    const abs = `${DATA()}/${rel}`
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true })
    const bytes = await pullFile(row.studio_id || '', name, abs)
    total += bytes
    if (total > MAX_OUTPUT_BYTES) { try { unlinkSync(abs) } catch { /* best-effort */ } throw fail(413, 'The studio files are larger than 1 GB.') }
    if (kind === 'shotlist') {
      try { shotlist = readFileSync(abs, 'utf8') } catch { shotlist = '' }
    }
    let libraryId: string | null = null
    if (kind !== 'shotlist') {
      const mime = SERVE[ext] || 'application/octet-stream'
      libraryId = upsertItem({
        type: mime.startsWith('image/') ? 'image' : 'media', sourceId: `mvfile:${row.id}:${name}`, userId: row.user_id, agentId: AGENT,
        title: `${row.title} · ${OUTPUT_LABEL[kind] || name}`, filePath: rel, mime, preview: row.title,
        tags: [AGENT, row.id, kind], meta: { ...metaOf(input, row.id), kind }
      })
    }
    saved.push({
      name, kind, label: OUTPUT_LABEL[kind] || name, bytes, libraryId,
      url: `/api/music-video/jobs/${row.id}/files/${encodeURIComponent(name)}?v=${gen}`,
      rel
    })
  }
  const text = [`# ${row.title}`, '', input.character ? `Character: ${input.character}` : 'Character: (picture)', '', 'Storyline:', storyText(input.storyline), '',
    `Style: ${input.style} · ${input.aspect} · lyrics ${input.lyrics ? 'on' : 'off'} · backend ${input.backend}`, `Song: ${input.songName}`, '',
    shotlist ? `## Shot list\n${shotlist}` : ''].filter(Boolean).join('\n')
  const libraryId = upsertItem({
    type: 'pipeline', sourceId: `mv:${row.id}`, userId: row.user_id, agentId: AGENT, title: `${row.title} · music video`,
    preview: storyText(input.storyline).slice(0, 300), body: text, tags: [AGENT, row.id, 'shotlist'],
    meta: metaOf(input, row.id), snapshot: { text, data: { input, files: saved.map(({ rel: _r, ...f }) => f) } }
  })
  const shot = saved.find((f) => f.kind === 'shotlist')
  if (shot) shot.libraryId = libraryId
  save(row.id, { status: 'done', stage: snap.stage || 'done', progress: snap.progress, shot: snap.shot, shots: snap.shots, error: null, files: saved, fails: 0, gen })
  try { appendRecord('music-video.done', { id: row.id, files: saved.map((f) => f.kind) }, { userId: row.user_id, agentId: AGENT }) } catch { /* record is best-effort */ }
}

function noteFailure(row: Row, e: any) {
  const fails = Number(row.fails || 0) + 1
  const message = String(e?.message || 'The video studio is not responding.')
  const terminal = e?.status === 404 || e?.status === 413 || fails >= FAIL_LIMIT
  save(row.id, { status: terminal ? 'error' : row.status, error: message, fails })
  return present(load(row.id) || row)
}

async function refresh(row: Row) {
  if (row.status === 'error') return present(row)
  if (row.status === 'done' && row.files) return present(row)
  if (!row.studio_id) return present(row)
  try {
    const snap = await snapshot(row.studio_id)
    if (snap.status === 'done') {
      await ingest(row, snap)
      return present(load(row.id) || row, snap)
    }
    const status = snap.status === 'error' ? 'error' : (snap.status === 'queued' || snap.status === 'running' ? snap.status : 'running')
    save(row.id, { status, stage: snap.stage, progress: snap.progress, shot: snap.shot, shots: snap.shots, fails: 0, error: snap.error || (status === 'error' ? 'The studio reported an error.' : null) })
    return present(load(row.id) || row, snap)
  } catch (e: any) { return noteFailure(row, e) }
}

let refreshing = false
async function refreshActive() {
  if (refreshing) return
  refreshing = true
  try {
    const stale = now() - 3 * 60_000
    db.prepare("update mv_jobs set status='error', error='The studio did not accept this job.', updated_at=? where status='submitting' and studio_id is null and updated_at<?").run(now(), stale)
    const rows = db.prepare("select * from mv_jobs where status in ('queued','running') and studio_id is not null order by updated_at asc limit 20").all() as Row[]
    for (const row of rows) {
      try { await lock(row.id, () => refresh(load(row.id) || row)) } catch (e: any) { console.error('[music-video]', row.id, e?.message || e) }
    }
  } finally { refreshing = false }
}

export function registerMusicVideoRoutes(app: FastifyInstance) {
  if (process.env.NODE_ENV !== 'test') setInterval(() => { refreshActive().catch(() => {}) }, 4000).unref()
  const uid = (req: any) => String(req.userId)
  const own = (req: any, reply: any) => {
    const row = load((req.params as any).id, uid(req))
    if (!row) reply.status(404).send({ error: 'Not found' })
    return row
  }
  const sendError = (reply: any, e: any) => reply.status(e?.status || 500).send({ error: String(e?.message || 'Music video request failed') })

  app.get('/api/music-video/status', async () => ping())
  app.get('/api/music-video/jobs', async (req) => {
    const rows = db.prepare('select * from mv_jobs where user_id=? order by created_at desc limit 40').all(uid(req)) as Row[]
    return { jobs: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, stage: r.stage, progress: r.progress ?? 0, shot: r.shot, shots: r.shots, error: r.error || undefined, createdAt: r.created_at, updatedAt: r.updated_at })) }
  })
  const idemKey = (req: any) => {
    const key = String(req.headers['idempotency-key'] || '').trim()
    return /^[\w-]{8,80}$/.test(key) ? key : ''
  }
  const accepted = (id: string, status: string) => ({ id, status, poll: `/api/music-video/jobs/${id}` })
  app.post('/api/music-video/jobs', async (req, reply) => {
    let id = ''
    try {
      const key = idemKey(req)
      if (key) {
        const ex = db.prepare('select id, status from mv_jobs where user_id=? and idem_key=?').get(uid(req), key) as any
        if (ex) return reply.status(202).send(accepted(ex.id, ex.status))
      }
      const { fields, files } = await readForm(req)
      const spec = normalize(fields, files)
      const active = (db.prepare("select count(*) n from mv_jobs where user_id=? and status in ('submitting','queued','running')").get(uid(req)) as any).n
      if (active >= ACTIVE_PER_USER) throw fail(429, `You already have ${ACTIVE_PER_USER} videos in progress. Wait for one to finish, or remove it.`)
      const { song, songExt, image, imageExt, ...input } = spec
      id = 'mv_' + randomBytes(8).toString('hex')
      const t = now()
      try {
        db.prepare('insert into mv_jobs(id,user_id,studio_id,title,status,stage,progress,input,idem_key,fails,gen,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, uid(req), null, input.title, 'submitting', 'submitting', 0, JSON.stringify(input), key || null, 0, 0, t, t)
      } catch (e: any) {
        if (key && /unique|constraint/i.test(String(e?.message))) {
          const ex = db.prepare('select id, status from mv_jobs where user_id=? and idem_key=?').get(uid(req), key) as any
          if (ex) return reply.status(202).send(accepted(ex.id, ex.status))
        }
        throw e
      }
      const created = await submit({ ...input, song, songExt, image, imageExt })
      save(id, { studio_id: created.id, status: 'queued', stage: 'queued' })
      try { appendRecord('music-video.make', { id, title: input.title, aspect: input.aspect, backend: input.backend, lyrics: input.lyrics }, { userId: uid(req), agentId: AGENT }) } catch { /* best-effort */ }
      return reply.status(202).send(accepted(id, 'queued'))
    } catch (e: any) {
      if (id && load(id)) save(id, { status: 'error', error: String(e?.message || 'The video studio request failed') })
      return sendError(reply, e)
    }
  })
  app.get('/api/music-video/jobs/:id', async (req, reply) => {
    const row = own(req, reply)
    if (!row) return reply
    try {
      return await lock(row.id, async () => {
        const fresh = load(row.id, uid(req))
        if (!fresh) return reply.status(404).send({ error: 'Not found' })
        return await refresh(fresh)
      })
    } catch (e: any) { return sendError(reply, e) }
  })
  app.get('/api/music-video/jobs/:id/files/:name', async (req, reply) => {
    const row = own(req, reply)
    if (!row) return reply
    const name = String((req.params as any).name || '')
    if (!/^[\w][\w.\-]*$/.test(name)) return reply.status(400).send({ error: 'Bad file name' })
    const file = (parse(row.files, []) as any[]).find((f) => f.name === name)
    if (!file?.rel || file.rel.includes('..') || !existsSync(`${DATA()}/${file.rel}`)) return reply.status(404).send({ error: 'Not ready' })
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const download = String((req.query as any).download || '') === '1'
    return reply.header('Content-Type', SERVE[ext] || 'application/octet-stream').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
      .send(createReadStream(`${DATA()}/${file.rel}`))
  })
  app.post('/api/music-video/jobs/:id/redo', async (req, reply) => {
    const row = own(req, reply)
    if (!row) return reply
    const shot = Number((req.body as any)?.shot)
    if (!Number.isInteger(shot) || shot < 1 || shot > 99) return reply.status(400).send({ error: 'Shot must be a number from 1 to 99.' })
    try {
      return await lock(row.id, async () => {
        const fresh = load(row.id) || row
        const prev = { status: fresh.status, stage: fresh.stage, progress: fresh.progress, shot: fresh.shot, shots: fresh.shots, error: fresh.error }
        // Mark it in progress before the call so a lost response cannot leave the old "done" cache in place.
        save(fresh.id, { status: 'running', stage: 'rendering', error: null, progress: 0 })
        try {
          const result = await redoShot(fresh.studio_id || '', shot)
          if (!result.supported) { save(fresh.id, prev); return { supported: false, message: result.message, status: prev.status } }
          save(fresh.id, { status: 'running', files: null, shot, progress: 0 })
          return { supported: true, status: 'running' }
        } catch (e: any) {
          if (e?.status === 400) save(fresh.id, prev)
          throw e
        }
      })
    } catch (e: any) { return sendError(reply, e) }
  })
  app.delete('/api/music-video/jobs/:id', async (req, reply) => {
    const row = own(req, reply)
    if (!row) return reply
    try {
      return await lock(row.id, async () => {
        const fresh = load(row.id, uid(req))
        if (!fresh) return { ok: true }
        await removeRemote(fresh.studio_id || '')
        db.prepare('delete from mv_jobs where id=?').run(fresh.id)
        return { ok: true }
      })
    } catch (e: any) { return sendError(reply, e) }
  })
}
