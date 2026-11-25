// Music Video Maker routes. A fake studio stands in for fraymus-video-studio so the proxy,
// library save, and the "studio is down" path can be checked without rendering anything.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = randomBytes(24).toString('hex')
const STUDIO_TOKEN = 'studio-test-token-' + randomBytes(8).toString('hex')
let failures = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const SONG = Buffer.from('ID3fake-song-bytes-for-the-music-video-test')
const STUDIO_FILES = {
  'master.mp4': Buffer.from('MASTER-VIDEO'),
  'lyrics.mp4': Buffer.from('LYRICS-VIDEO'),
  'phone.mp4': Buffer.from('PHONE-VIDEO'),
  'qc-contact.png': Buffer.from('PNG-SHEET'),
  'shotlist.md': Buffer.from('# Shot list\n\n1. Rain on the window\n')
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length })
  res.end(b)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const studioJobs = new Map()
let studioPosts = 0
let lastJobBody = null
const studio = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/$/, '') || '/'
  if (path === '/health') return json(res, 200, { ok: true, recipes: ['explainer', 'anime-mv'], queue: 0 })
  if (req.headers.authorization !== `Bearer ${STUDIO_TOKEN}`) return json(res, 401, { error: 'unauthorized' })
  if (path === '/recipes') return json(res, 200, [{ name: 'anime-mv' }])
  if (req.method === 'POST' && path === '/jobs') {
    const body = await readBody(req)
    studioPosts++
    lastJobBody = body
    if (body?.options?.character === 'FAIL_STUDIO') return json(res, 500, { error: 'render exploded' })
    const id = randomBytes(6).toString('hex')
    studioJobs.set(id, { polls: 0 })
    return json(res, 202, { id, status: 'queued', status_url: `/jobs/${id}` })
  }
  const job = path.match(/^\/jobs\/([a-f0-9]{12})$/)
  if (job && req.method === 'GET') {
    const row = studioJobs.get(job[1])
    if (!row) return json(res, 404, { error: 'no such job' })
    row.polls++
    if (row.polls < 2) return json(res, 200, { id: job[1], status: 'running', stage: 'rendering', progress: 0.34, shot: 1, shots: 3 })
    return json(res, 200, {
      id: job[1], status: 'done', stage: 'done', progress: 1, shot: 3, shots: 3,
      files: Object.keys(STUDIO_FILES).map((name) => ({ name, url: `/jobs/${job[1]}/files/${name}` }))
    })
  }
  const file = path.match(/^\/jobs\/([a-f0-9]{12})\/files\/([\w.\-]+)$/)
  if (file && req.method === 'GET') {
    const buf = STUDIO_FILES[file[2]]
    if (!buf) return json(res, 404, { error: 'no such file' })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length })
    return res.end(buf)
  }
  if (req.method === 'POST' && /\/redo$/.test(path)) return json(res, 404, { error: 'not found' })
  if (job && req.method === 'DELETE') { studioJobs.delete(job[1]); return json(res, 200, { deleted: job[1] }) }
  return json(res, 404, { error: 'not found' })
})

function boot(envExtra) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mv-test-'))
  const port = String(5400 + Math.floor(Math.random() * 800))
  const env = {
    ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'none', SCHEDULER: 'off', NODE_ENV: 'test',
    WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: TOKEN, CLERK_SECRET_KEY: '', SUPABASE_URL: '', LIBRARY_SYNC_MS: '600000',
    GROQ_API_KEY: '', HF_TOKEN: '', IMAGE_PROVIDERS: 'placeholder', LOGIC_CHAIN: 'off', STUDIO_URL: '', STUDIO_TOKEN: '', ...envExtra
  }
  const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore', detached: true })
  const base = `http://127.0.0.1:${port}`
  const stop = () => new Promise((r) => { p.on('exit', () => setTimeout(r, 200)); try { process.kill(-p.pid) } catch { p.kill() } try { rmSync(dataDir, { recursive: true, force: true }) } catch {} })
  return { base, stop }
}
async function ready(base) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) return true } catch {} await sleep(400) }
  return false
}
const api = (base) => async (path, opts = {}) => {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }
  const r = await fetch(base + path, { ...opts, headers })
  const buf = Buffer.from(await r.arrayBuffer())
  let body = null
  try { body = JSON.parse(buf.toString()) } catch { body = buf }
  return { status: r.status, body, buf, text: buf.toString() }
}

function jobForm(fields, files = []) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  for (const f of files) fd.append(f.field, new Blob([f.buf], { type: f.type }), f.name)
  return fd
}
const songFile = { field: 'song', buf: SONG, type: 'audio/mpeg', name: 'rain.mp3' }
const faceFile = { field: 'character_image', buf: PNG, type: 'image/png', name: 'character.png' }

const apps = []
try {
  await new Promise((resolve) => studio.listen(0, '127.0.0.1', resolve))
  const studioPort = studio.address().port
  const live = boot({ STUDIO_URL: `http://127.0.0.1:${studioPort}`, STUDIO_TOKEN })
  const mock = boot({})
  const down = boot({ STUDIO_URL: 'http://127.0.0.1:9', STUDIO_TOKEN: 'down-token' })
  const notoken = boot({ STUDIO_URL: 'http://127.0.0.1:9', STUDIO_TOKEN: '' })
  apps.push(live, mock, down, notoken)
  const up = await Promise.all([ready(live.base), ready(mock.base), ready(down.base), ready(notoken.base)])
  ok(up.every(Boolean), 'servers started')
  if (!up.every(Boolean)) throw new Error('a test server did not start')

  const L = api(live.base), M = api(mock.base), D = api(down.base), N = api(notoken.base)
  ok((await fetch(live.base + '/api/music-video/status')).status === 401, 'gate: /api/music-video requires the workspace token')

  const st = await L('/api/music-video/status')
  ok(st.status === 200 && st.body.mode === 'live' && st.body.reachable === true && st.body.recipe === 'anime-mv' && st.body.recipeReady === true, 'status: live studio, anime-mv recipe listed')
  ok(!st.text.includes(STUDIO_TOKEN) && !JSON.stringify(st.body).includes(STUDIO_TOKEN), 'status: studio token is not in the response')

  const beats = 'She waits by the window\nRain on the glass\nShe almost calls'
  const made = await L('/api/music-video/jobs', { method: 'POST', body: jobForm({
    character: 'A young woman with black hair and a cream sweater', storyline: beats, aspect: '9:16', lyrics: 'false', backend: 'comfy', consent: 'true', title: 'Rain window'
  }, [songFile, faceFile]) })
  ok(made.status === 202 && /^mv_[a-f0-9]+$/.test(made.body.id), 'create: 202 and a local job id')
  ok(studioPosts === 1 && lastJobBody?.recipe === 'anime-mv' && lastJobBody?.consent === true, 'create: studio received recipe anime-mv and consent')
  ok(lastJobBody?.options?.character?.includes('black hair') && Array.isArray(lastJobBody?.options?.storyline) && lastJobBody.options.storyline[1] === 'Rain on the glass', 'create: character text and storyline beats')
  ok(lastJobBody?.options?.style === 'anime' && lastJobBody?.options?.aspect === '9:16' && lastJobBody?.options?.lyrics === false && lastJobBody?.options?.backend === 'comfy', 'create: style defaults to anime; aspect, lyrics and backend passed through')
  ok(lastJobBody?.files?.song === SONG.toString('base64') && lastJobBody?.files?.song_ext === '.mp3', 'create: song bytes and extension')
  ok(lastJobBody?.files?.character_image === PNG.toString('base64') && lastJobBody?.files?.character_image_ext === '.png', 'create: optional character image')
  ok(typeof lastJobBody?.script === 'string' && lastJobBody.script.includes('Rain on the glass'), 'create: a script is sent for studios that still require one')
  ok(!made.text.includes(STUDIO_TOKEN), 'create: response does not contain the studio token')

  let job = await L('/api/music-video/jobs/' + made.body.id)
  ok(job.body.status === 'running' && job.body.shot === 1 && job.body.shots === 3, 'poll: shot 1 of 3 while the studio is rendering')
  job = await L('/api/music-video/jobs/' + made.body.id)
  ok(job.body.status === 'done' && job.body.progress === 1, 'poll: done on the next read')
  const kinds = Object.fromEntries((job.body.files || []).map((f) => [f.kind, f]))
  ok(kinds.master && kinds.lyrics && kinds.phone && kinds.contact && kinds.shotlist, 'done: clean master, lyrics master, phone copy, contact sheet, shot list')
  const master = await L(kinds.master.url)
  ok(master.status === 200 && master.buf.equals(STUDIO_FILES['master.mp4']), 'file: master bytes match the studio')
  const sheet = await L(kinds.shotlist.url)
  ok(sheet.status === 200 && sheet.text.includes('Shot list'), 'file: shot list markdown is served')
  ok(!job.text.includes(STUDIO_TOKEN), 'poll: studio token stays off the job payload')

  const lib = await L('/api/library?tag=' + encodeURIComponent(made.body.id) + '&limit=20')
  ok(lib.body.items?.length >= 5, `library: outputs saved (${lib.body.items?.length})`)
  ok(lib.body.items.some((i) => i.meta?.character?.includes('black hair') && JSON.stringify(i.meta?.storyline || '').includes('Rain on the glass')), 'library: character and storyline stored as metadata')
  const pipe = lib.body.items.find((i) => i.type === 'pipeline')
  const detail = pipe ? await L('/api/library/items/' + pipe.id) : { body: {} }
  ok(String(detail.body?.content || '').includes('Rain on the glass'), 'library: pipeline snapshot keeps the storyline')

  const redo = await L(`/api/music-video/jobs/${made.body.id}/redo`, { method: 'POST', body: JSON.stringify({ shot: 2 }) })
  ok(redo.status === 200 && redo.body.supported === false && /not|does not|yet/i.test(redo.body.message || ''), 'redo: 404 from the studio is a graceful stub')
  ok((await L('/api/music-video/jobs/' + made.body.id)).body.status === 'done', 'redo: a stub does not throw away the finished job')

  const listed = await L('/api/music-video/jobs')
  ok(listed.body.jobs?.some((j) => j.id === made.body.id), 'list: the job is visible to its owner')
  ok((await L('/api/music-video/jobs/' + made.body.id, { method: 'DELETE' })).status === 200, 'delete: job removed')
  ok((await L('/api/music-video/jobs/' + made.body.id)).status === 404, 'delete: a later read is 404')

  const postsBefore = studioPosts
  const bad = async (fields, files, re, label) => {
    const r = await L('/api/music-video/jobs', { method: 'POST', body: jobForm(fields, files) })
    ok(r.status === 400 && re.test(r.body?.error || ''), label)
  }
  await bad({ storyline: 'x', consent: 'true' }, [], /song/i, 'validate: song required')
  await bad({ storyline: 'x', consent: 'true' }, [songFile], /character/i, 'validate: character text or image required')
  await bad({ character: 'A girl', consent: 'true' }, [songFile], /storyline/i, 'validate: storyline required')
  await bad({ character: 'A girl', storyline: 'Rain', aspect: '9:16' }, [songFile], /rights|consent/i, 'validate: consent required')
  await bad({ character: 'A girl', storyline: 'Rain', consent: 'true', aspect: '4:3' }, [songFile], /aspect/i, 'validate: aspect is 16:9 or 9:16')
  await bad({ character: 'A girl', storyline: 'Rain', consent: 'true', backend: 'paid' }, [songFile], /backend/i, 'validate: backend is hf or comfy')
  ok(studioPosts === postsBefore, 'validate: rejected jobs are not sent to the studio')

  const boom = await L('/api/music-video/jobs', { method: 'POST', body: jobForm({ character: 'FAIL_STUDIO', storyline: 'Rain', consent: 'true' }, [songFile]) })
  ok(boom.status === 502 && /render exploded/.test(boom.body?.error || '') && !boom.text.includes(STUDIO_TOKEN), 'studio 500: the error is surfaced and the token is not')

  const faceOnly = await L('/api/music-video/jobs', { method: 'POST', body: jobForm({ storyline: 'One quiet verse', consent: 'true' }, [songFile, faceFile]) })
  ok(faceOnly.status === 202 && lastJobBody?.files?.character_image && !lastJobBody?.options?.character, 'create: a character image is enough when there is no description')

  const downStatus = await D('/api/music-video/status')
  ok(downStatus.status === 200 && downStatus.body.mode === 'live' && downStatus.body.reachable === false && /not responding|unreachable/i.test(downStatus.body.message || ''), 'down: status is a clear message, not a crash')
  const downMake = await D('/api/music-video/jobs', { method: 'POST', body: jobForm({ character: 'A girl', storyline: 'Rain', consent: 'true' }, [songFile]) })
  ok(downMake.status === 503 && /not responding|unreachable/i.test(downMake.body?.error || ''), 'down: Make returns 503')

  const missingTok = await N('/api/music-video/status')
  ok(missingTok.status === 200 && missingTok.body.reachable === false && /STUDIO_TOKEN/.test(missingTok.body.message || ''), 'misconfigured: missing STUDIO_TOKEN is reported')

  const mockStatus = await M('/api/music-video/status')
  ok(mockStatus.status === 200 && mockStatus.body.mode === 'mock' && mockStatus.body.reachable === true, 'mock: STUDIO_URL unset is demo mode')
  const mockJob = await M('/api/music-video/jobs', { method: 'POST', body: jobForm({ character: 'A girl in a cream sweater', storyline: 'She watches the rain', consent: 'true' }, [songFile]) })
  ok(mockJob.status === 202, 'mock: Make starts without a studio')
  let mj = null
  for (let i = 0; i < 8; i++) { mj = await M('/api/music-video/jobs/' + mockJob.body.id); if (mj.body.status === 'done') break }
  ok(mj?.body?.status === 'done' && mj.body.shot && mj.body.shots && mj.body.files?.some((f) => f.kind === 'master') && mj.body.files.some((f) => f.kind === 'lyrics'), 'mock: progress reaches done with a master and a lyrics master')
  const mockMaster = await M(mj.body.files.find((f) => f.kind === 'master').url)
  ok(mockMaster.status === 200 && mockMaster.buf.slice(4, 8).toString() === 'ftyp', 'mock: the sample master is a real mp4')
  const mockLib = await M('/api/library?tag=' + encodeURIComponent(mockJob.body.id))
  ok(mockLib.body.items?.some((i) => i.meta?.storyline === 'She watches the rain' || (Array.isArray(i.meta?.storyline) && i.meta.storyline.includes('She watches the rain'))), 'mock: finished files land in the Library with the storyline')
  const mockRedo = await M(`/api/music-video/jobs/${mockJob.body.id}/redo`, { method: 'POST', body: JSON.stringify({ shot: 1 }) })
  ok(mockRedo.status === 200 && mockRedo.body.supported === true, 'mock: redo shot is available in demo mode')
  ok((await M('/api/music-video/jobs/' + mockJob.body.id)).body.status === 'running', 'mock: redo puts the job back in progress')
} catch (e) {
  console.error(e)
  failures++
} finally {
  await new Promise((r) => studio.close(r))
  await Promise.all(apps.map((a) => a.stop()))
  process.exit(failures ? 1 : 0)
}
