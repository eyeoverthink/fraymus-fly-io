// Self-contained test for Story Shorts (server/shorts): planning + verification, staged runs that stop on a failed
// check, per-shot uploads (GPU renders from the PC), Whisper timings, the offline render (ffmpeg), Library saves,
// study of a reference video, and record events. Uses a small frame size so it runs in a minute or two.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { verify } from './verify-record.mjs'

const TOKEN = randomBytes(24).toString('hex')
let failures = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']).status !== 0) { console.log('skip: ffmpeg not installed'); process.exit(0) }

const STORY = "It's June 1859 on San Juan Island, claimed by both America and Britain. You're farmer Lyman Cutler, and a pig is eating your potatoes, so you shoot it. The pig belongs to a man working for a British company. You offer ten dollars. He wants a hundred. Soon, American soldiers land on the island. Britain sends warships. By August, hundreds of troops and five warships face each other. But the British admiral refuses to start a war over a pig. Nobody fires a shot. The only casualty was the pig."
const W = 270, HH = 480

const dataDir = mkdtempSync(join(tmpdir(), 'shorts-test-'))
const port = String(5300 + Math.floor(Math.random() * 400))
const env = { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'none', SCHEDULER: 'off', NODE_ENV: 'test', WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: TOKEN,
  GROQ_API_KEY: '', CLERK_SECRET_KEY: '', SUPABASE_URL: '', FREE_CREDITS: '', LIBRARY_SYNC_MS: '600000', REPLICATE_API_TOKEN: '', FAL_KEY: '', HF_TOKEN: '', SHORTS_FFMPEG_THREADS: '4' }
const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore', detached: true })
const base = `http://127.0.0.1:${port}`
const stop = () => new Promise((r) => { p.on('exit', () => setTimeout(r, 300)); try { process.kill(-p.pid) } catch { p.kill() } })
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const api = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { ...AUTH, ...(opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) } }
const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) })
const upload = async (path, buf, name, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); return api(path, { method: 'POST', body: fd }) }
async function until(id, done = (r) => !['running', 'new'].includes(r.status), ms = 400_000) {
  const t = Date.now(); let r
  while (Date.now() - t < ms) { r = (await api(`/api/shorts/runs/${id}`)).body; if (r && done(r)) return r; await sleep(700) }
  return r
}
const probe = (file) => { const r = spawnSync(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' }); return JSON.parse(r.stdout || '{}') }

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(400) }

  // --- gate + status
  ok((await fetch(base + '/api/shorts/status')).status === 401, 'gate: /api/shorts needs the workspace token')
  const st = (await api('/api/shorts/status')).body
  ok(st.stages.join() === 'script,plan,voice,images,clips,sfx,edit,qa' && st.rules.length >= 18 && st.cast.some((c) => c.main), 'status: stages, 18 rules and a cast with a main character')
  ok(st.tools.ffmpeg === true, 'status: ffmpeg detected')

  // --- plan preview (no rendering): word-for-word, 12 shots, main character in most shots
  const pv = (await post('/api/shorts/plan', { story: STORY, title: 'The Pig War' })).body
  ok(pv.plan.shots.length === 12, 'plan: 12 shots')
  ok(pv.plan.shots.map((s) => s.text).join(' ') === STORY, 'plan: shots join back to the narration word for word')
  ok(pv.verify.ok && pv.verify.stats.withMain >= 8, 'plan: verified, main character in most shots')
  ok(pv.plan.shots.every((s) => /no text/i.test(s.picture) && s.motion && s.sfx), 'plan: every shot has a picture prompt (no text), camera move and sound')
  ok(pv.check.stats.youCount >= 2, 'script: addressed to "you"')
  ok((await post('/api/shorts/plan', {})).status === 400, 'plan: story required')

  // --- staged run: stop after plan, both stages saved to the Library
  const c = (await post('/api/shorts/runs', { story: STORY, title: 'The Pig War', width: W, height: HH, fps: 15, until: 'plan' })).body
  ok(/^sht_/.test(c.runId), 'run: created')
  let run = await until(c.runId)
  if (run.status !== 'paused') console.log('     run:', JSON.stringify({ status: run.status, error: run.error, stages: run.stages }))
  ok(run.status === 'paused' && run.stages.script?.status === 'done' && run.stages.plan?.status === 'done', 'run: paused after "plan" (staged)')
  ok(run.check.issues.some((x) => /hook/.test(x)), 'script: slow hook reported as advice (not blocking)')
  let lib = (await api('/api/library?type=pipeline')).body
  ok(lib.items.some((i) => i.sourceId === `shorts:${c.runId}:plan`) && lib.items.some((i) => i.sourceId === `shorts:${c.runId}:script`), 'library: script + plan saved as pipeline items')

  // --- a broken plan edit is caught (narration must stay word for word) and blocks the run
  const bad = (await post(`/api/shorts/runs/${c.runId}/plan`, { shots: [{ n: 3, text: 'and a goat ate your potatoes' }] }, 'PATCH')).body
  ok(bad.verify.ok === false && bad.verify.issues.some((x) => /word for word|differs|narration/i.test(x)), 'verify: changed narration is flagged')
  await post(`/api/shorts/runs/${c.runId}/run`, { until: 'plan' }); run = await until(c.runId)
  ok(run.status === 'blocked' && run.stages.plan.status === 'blocked', 'verify: run blocks at plan instead of wasting the next steps')
  const orig = pv.plan.shots.find((s) => s.n === 3).text
  ok((await post(`/api/shorts/runs/${c.runId}/plan`, { shots: [{ n: 3, text: orig, motion: 'tilt-up' }] }, 'PATCH')).body.verify.ok, 'verify: remade shot passes')

  // --- uploaded picture that breaks the rules (plain, cold) is caught at the images stage
  const plain = await sharp({ create: { width: W, height: HH, channels: 3, background: '#2040c0' } }).png().toBuffer()
  const up1 = (await upload(`/api/shorts/runs/${c.runId}/assets/image/1`, plain, 'shot1.png', 'image/png')).body
  ok(up1.ok && up1.check.ok === false, 'upload: plain cold picture flagged on upload')
  await post(`/api/shorts/runs/${c.runId}/run`, { until: 'images' }); run = await until(c.runId)
  ok(run.status === 'blocked' && run.stages.images?.status === 'blocked' && !run.stages.clips, 'images: bad picture blocks before any clip is made')
  ok(run.images.length === 12 && run.images.filter((i) => i.source === 'storyboard').length === 11, 'images: 11 offline storyboard frames + 1 upload')
  ok(run.images.filter((i) => i.source === 'storyboard').every((i) => i.check.ok), 'images: storyboard frames pass the picture checks')

  // replace it with a good GPU-style render from the PC
  const good = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HH}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7c27a"/><stop offset="1" stop-color="#6a3b22"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="135" cy="170" r="50" fill="#9be3c3" stroke="#222" stroke-width="4"/></svg>`)).png().toBuffer()
  ok((await upload(`/api/shorts/runs/${c.runId}/assets/image/1`, good, 'shot1.png', 'image/png')).body.check.ok, 'upload: good picture passes')
  ok((await upload(`/api/shorts/runs/${c.runId}/assets/model/1`, good, 'x.png', 'image/png')).status === 400, 'upload: unknown asset kind rejected')

  // --- full offline render to the end
  const t0 = Date.now()
  await post(`/api/shorts/runs/${c.runId}/run`, { until: 'qa' }); run = await until(c.runId)
  console.log(`     render took ${((Date.now() - t0) / 1000).toFixed(1)}s, voice engine: ${run.voice?.engine}, status ${run.status}${run.error ? ' (' + run.error + ')' : ''}`)
  ok(['done', 'failed_qa'].includes(run.status) && run.stages.qa, 'render: ran through qa')
  ok(run.images[0].source === 'upload' && run.clips.length === 12 && run.sfx.length === 12, 'render: uploaded picture used, 12 clips, 12 sound effects')
  ok(run.cuts.every((cut, i) => i === 0 || Math.abs(cut.start - (cut.firstWord - 0.08)) < 0.01), 'edit: each cut lands just before the shot\'s first word')
  ok(run.qa.stats.drift <= 0.25, `qa: cut drift ${run.qa.stats.drift}s within rule E1`)
  const finalPath = join(dataDir, run.final.url)
  ok(existsSync(finalPath), 'edit: final short written to outputs')
  const pr = probe(finalPath)
  const v = pr.streams?.find((s) => s.codec_type === 'video'), a = pr.streams?.find((s) => s.codec_type === 'audio')
  ok(v?.width === W && v?.height === HH && !!a, `edit: vertical ${W}x${HH} video with an audio track`)
  ok(Math.abs(Number(pr.format?.duration) - (run.voice.seconds + 0.3)) < 1, `edit: length ${Number(pr.format?.duration).toFixed(1)}s follows the voice (${run.voice.seconds}s)`)
  ok((await fetch(base + run.final.url)).status === 200, 'edit: final short served at /outputs')
  if (run.voice.engine !== 'silent-guide') ok(run.final.lufs >= -16 && run.final.lufs <= -12, `audio: ${run.final.lufs} LUFS within -16..-12`)
  else ok(run.qa.stats.warnings.some((w) => /silent/.test(w)), 'audio: silent guide voice is reported in QA (no espeak-ng/piper on this machine)')

  lib = (await api('/api/library?type=pipeline&limit=100')).body
  const stagesSaved = new Set(lib.items.filter((i) => i.sourceId.startsWith(`shorts:${c.runId}:`)).map((i) => i.sourceId.split(':')[2]))
  ok(['script', 'plan', 'voice', 'images', 'clips', 'sfx', 'edit', 'qa'].every((s) => stagesSaved.has(s)), 'library: every stage saved as a pipeline item')
  const media = (await api('/api/library?type=image,media&limit=200')).body.items.filter((i) => i.tags.includes(c.runId))
  ok(media.length >= 12 + 12 + 12 + 2, `library: pictures, clips, sfx, voice and the final short saved (${media.length} files)`)

  // --- Whisper word timings from the PC: a voice take that doesn't match the script blocks the voice stage
  const words = STORY.split(' ').map((w, i) => ({ w, start: i * 0.35, end: i * 0.35 + 0.3 }))
  words[5].w = 'Bob'
  const tm = (await post(`/api/shorts/runs/${c.runId}/timings`, { words })).body
  ok(tm.ok && tm.match.ok === false && tm.match.edits === 1, 'timings: mismatch against the script detected')
  await post(`/api/shorts/runs/${c.runId}/run`, { until: 'voice' }); run = await until(c.runId)
  ok(run.status === 'blocked' && run.stages.voice.status === 'blocked', 'voice: take that is not word for word blocks the run')
  words[5].w = STORY.split(' ')[5]
  ok((await post(`/api/shorts/runs/${c.runId}/timings`, { words })).body.match.ok, 'timings: matching take accepted')
  await post(`/api/shorts/runs/${c.runId}/run`, { until: 'clips' }); run = await until(c.runId)
  ok(run.status === 'paused' && run.timingSource === 'upload' && Math.abs(run.cuts[1].firstWord - words.findIndex((w, i) => i > 0 && run.plan.shots[1].text.startsWith(w.w)) * 0.35) < 0.4, 'timings: uploaded word timings drive the cuts')

  // --- study a reference short (stage 0)
  const fs = await import('node:fs')
  const sd = (await upload('/api/shorts/study', fs.readFileSync(finalPath), 'ref.mp4', 'video/mp4')).body
  ok(sd.vertical === true && sd.shots >= 1 && sd.seconds > 20 && !!sd.sheet && !!sd.libraryId, `study: measured reference (${sd.seconds}s, ${sd.shots} shots, avg ${sd.avgShotSeconds}s) + contact sheet saved`)

  // --- delete keeps Library items; record chain intact
  ok((await api(`/api/shorts/runs/${c.runId}`, { method: 'DELETE' })).status === 200 && (await api(`/api/shorts/runs/${c.runId}`)).status === 404, 'delete: run removed')
  ok((await api('/api/library?type=pipeline&limit=100')).body.items.some((i) => i.sourceId === `shorts:${c.runId}:qa`), 'delete: Library copies are kept')
  const exp = await fetch(base + '/api/memory/record/export', { headers: AUTH }).then((r) => r.text())
  ok(verify(exp).ok && ['shorts.create', 'shorts.stage', 'shorts.study'].every((k) => exp.includes(`"kind":"${k}"`)), 'record: shorts events logged, chain verifies')
} catch (e) { console.error(e); failures++ } finally { await stop(); try { rmSync(dataDir, { recursive: true, force: true }) } catch {} }
console.log(failures ? `\n${failures} shorts check(s) FAILED` : '\nAll shorts checks passed')
process.exit(failures ? 1 : 0)
