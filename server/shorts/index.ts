// Story Shorts: the "AI cartoon story shorts" workflow, abstracted into staged, verifiable steps that run on
// free offline tools inside the Fly machine (see plan.ts / media.ts). Every stage's output is saved to the Library
// (type "pipeline", plus image/media items for files) so nothing produced is lost, and each stage is checked before
// the next one starts, so a failure stops the run instead of wasting work downstream ("blocked" + issues).
// GPU-only work (diffusion pictures, image-to-video, Whisper word timings) can run on the PC/Pi/VPS and be uploaded
// per shot; when nothing is uploaded the CPU fallbacks below are used.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import type { FastifyInstance } from 'fastify'
import { db, now } from '../agent/db'
import { registerTools, type Tool } from '../agent/tools'
import { appendRecord } from '../memory/record'
import { addOutputFile, upsertItem } from '../library'
import {
  DEFAULT_CAST, DEFAULT_RULES, MOTIONS, buildPlan, captionsAss, checkScript, cutDrift, cutTimes, estimateTimings, matchTranscript, verifyPlan,
  type CastMember, type Check, type Plan, type Rule, type Word
} from './plan'
import { fetchLocalImage } from '../image-generation'
import { SFX_TAGS, checkClip, checkPicture, clipFromImage, duration, finalEdit, loudness, makeSfx, storyboardFrame, studyReference, synthVoice, toolStatus } from './media'

export const STAGES = ['script', 'plan', 'voice', 'images', 'clips', 'sfx', 'edit', 'qa'] as const
export type Stage = typeof STAGES[number]
const DATA = () => process.env.DATA_DIR || './data'
const OUT = () => `${DATA()}/outputs`
const workDir = (id: string) => `${DATA()}/shorts/${id}`

db.exec(`create table if not exists shorts_runs(id text primary key, user_id text not null, title text, status text, stage text, input text, state text, error text, created_at integer, updated_at integer);
create index if not exists idx_shorts_user on shorts_runs(user_id, created_at);`)

type Input = { title: string; story: string; shots: number; cast: CastMember[]; rules: Rule[]; style?: string; w: number; h: number; fps: number; strict: boolean; minSeconds?: number; maxSeconds?: number }
type StageInfo = { status: 'done' | 'blocked' | 'error'; at: number; issues: string[]; libraryId?: string | null; seconds?: number }
type State = {
  check?: Check; plan?: Plan; verify?: Check
  voice?: { file: string; url: string; engine: string; seconds: number; uploaded?: boolean; heard?: string; match?: any; sha?: string }
  timings?: Word[]; timingSource?: string
  timingsFor?: string // sha256 of the voice take the uploaded word timings were made from
  images?: { n: number; url: string; source: string; check: Check; note?: string }[]
  clips?: { n: number; url: string; source: string; check: Check }[]
  sfx?: { n: number; tag: string; url: string }[]
  cuts?: ReturnType<typeof cutTimes>; drift?: number
  final?: { url: string; seconds: number; lufs: number | null }
  qa?: Check
  stages: Partial<Record<Stage, StageInfo>>
}
type Row = { id: string; user_id: string; title: string; status: string; stage: string | null; input: string; state: string; error: string | null; created_at: number; updated_at: number }

const parse = (s: any, d: any) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const load = (id: string, userId?: string) => db.prepare(`select * from shorts_runs where id=?${userId ? ' and user_id=?' : ''}`).get(...(userId ? [id, userId] : [id])) as Row | undefined
const save = (id: string, f: Partial<{ status: string; stage: string | null; state: State; error: string | null; input: Input }>) => {
  const k = Object.keys(f)
  db.prepare(`update shorts_runs set ${k.map((x) => `${x}=?`).join(',')}, updated_at=? where id=?`).run(...k.map((x) => { const v = (f as any)[x]; return v && typeof v === 'object' ? JSON.stringify(v) : v }), now(), id)
}
const view = (r: Row) => {
  const state = parse(r.state, { stages: {} }) as State
  return { id: r.id, title: r.title, status: r.status, stage: r.stage, error: r.error || undefined, input: parse(r.input, {}), ...state, createdAt: r.created_at, updatedAt: r.updated_at }
}

function normInput(b: any): Input {
  const story = String(b.story || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  if (!story) throw new Error('story required (the narration, word for word)')
  const w = Math.min(Math.max(Math.round(Number(b.width) || 1080), 144), 1080), h = Math.min(Math.max(Math.round(Number(b.height) || 1920), 256), 1920)
  const cast = Array.isArray(b.cast) && b.cast.length ? b.cast.slice(0, 8).map((c: any, i: number) => ({ id: String(c.id || `c${i}`), name: String(c.name || c.id || `Cast ${i + 1}`), role: String(c.role || ''), look: String(c.look || ''), palette: Array.isArray(c.palette) ? c.palette.map(String).slice(0, 4) : [], main: !!c.main })) : DEFAULT_CAST
  if (!cast.some((c: CastMember) => c.main)) cast[0].main = true
  return {
    title: String(b.title || story.split(/[.!?]/)[0]).slice(0, 120), story, shots: Math.min(Math.max(Number(b.shots) || 12, 3), 20), cast,
    rules: Array.isArray(b.rules) && b.rules.length ? b.rules : DEFAULT_RULES, style: b.style ? String(b.style).slice(0, 400) : undefined,
    w: w - (w % 2), h: h - (h % 2), fps: Math.min(Math.max(Number(b.fps) || 30, 12), 30), strict: b.strict !== false,
    minSeconds: b.minSeconds != null ? Number(b.minSeconds) : undefined, maxSeconds: b.maxSeconds != null ? Number(b.maxSeconds) : undefined
  }
}

// Publish a work file into /outputs (served publicly by name) and register it in the Library under its creator.
function publish(run: Row, src: string, name: string, title: string, stage: Stage, meta: any = {}) {
  mkdirSync(OUT(), { recursive: true })
  const file = `shorts-${run.id}-${name}`
  copyFileSync(src, `${OUT()}/${file}`)
  addOutputFile(file, { userId: run.user_id, agentId: 'shorts', title, tags: ['shorts', stage, run.id], meta: { runId: run.id, stage, ...meta } })
  return `/outputs/${file}`
}
function saveStage(run: Row, stage: Stage, text: string, data: any) {
  return upsertItem({ type: 'pipeline', sourceId: `shorts:${run.id}:${stage}`, userId: run.user_id, agentId: 'shorts', title: `${run.title} · ${stage}`,
    preview: text.slice(0, 300), body: text, tags: ['shorts', stage, run.id], meta: { runId: run.id, stage }, snapshot: { text, data } })
}
const uploaded = (id: string, kind: string, n: number | string, ext: string) => { const p = `${workDir(id)}/upload-${kind}-${n}.${ext}`; return existsSync(p) ? p : null }
const fileSha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const uploadedVoice = (id: string) => uploaded(id, 'voice', 0, 'wav') || uploaded(id, 'voice', 0, 'mp3')

// ---------- stages ----------
async function runStage(run: Row, input: Input, st: State, stage: Stage): Promise<{ issues: string[]; text: string; data: any }> {
  const dir = workDir(run.id); mkdirSync(dir, { recursive: true })
  const need = (k: keyof State, s: Stage) => { if (!st[k]) throw new Error(`run the "${s}" stage first`) }
  switch (stage) {
    case 'script': {
      st.check = checkScript(input.story, { minSeconds: input.minSeconds, maxSeconds: input.maxSeconds })
      // writing guidelines (length, hook, "you") are advisory: the narration is the author's; they're reported, not blocking
      return { issues: [], text: `${input.title}\n\n${input.story}\n\n${st.check.ok ? 'Script check passed' : 'Script issues:\n- ' + st.check.issues.join('\n- ')}`, data: { story: input.story, check: st.check, rules: input.rules, cast: input.cast } }
    }
    case 'plan': {
      if (!st.plan) st.plan = buildPlan({ title: input.title, story: input.story, shots: input.shots, cast: input.cast, rules: input.rules, style: input.style })
      st.verify = verifyPlan(st.plan, input.story, input.cast)
      const text = st.plan.shots.map((s) => `${s.n}. [${s.motion} · ${s.sfx} · ${s.cast.join('+') || 'no cast'}] ${s.text}`).join('\n')
      return { issues: st.verify.issues, text: `${st.plan.shots.length} shots, ~${st.plan.estSeconds}s\n${text}`, data: { plan: st.plan, verify: st.verify } }
    }
    case 'voice': {
      need('plan', 'plan')
      const issues: string[] = [], notes: string[] = []
      const up = uploadedVoice(run.id)
      const wav = `${dir}/voice.wav`
      const hadTimings = st.timingSource === 'upload' && !!st.timings
      // Uploaded word timings belong to one specific take. If they were made from the take we already have (and no new
      // voice was uploaded), keep that take instead of re-synthesising, so the timings still line up with the audio.
      const keep = !up && hadTimings && st.voice?.file && existsSync(st.voice.file) && st.timingsFor && fileSha(st.voice.file) === st.timingsFor
      let engine = 'upload', seconds = 0, file = wav
      if (keep) { file = st.voice!.file; engine = st.voice!.engine; seconds = await duration(file) }
      else if (up) { file = wav.replace(/wav$/, up.split('.').pop()!); copyFileSync(up, file); seconds = await duration(up) }
      else {
        const v = await synthVoice(input.story, wav, st.plan!.estSeconds); engine = v.engine; seconds = v.seconds
        if (v.err) issues.push('voice: ' + v.err)
        if (v.fallback) notes.push(`voice fell back to ${v.engine}: ${v.fallback}`)
      }
      if (!seconds) issues.push('voice track is empty')
      if (engine === 'silent-guide') notes.push('no offline voice engine found (espeak-ng/piper): a silent guide track with estimated timings was used; upload a voice WAV to replace it')
      const sha = existsSync(file) ? fileSha(file) : undefined
      const prev = hadTimings && sha && st.timingsFor === sha ? st.timings! : null
      if (hadTimings && !prev) notes.push('uploaded word timings were for a different voice take, so they were dropped; timings are estimated (re-run Whisper on this take for exact cuts)')
      st.timings = prev || estimateTimings(input.story, seconds || st.plan!.estSeconds)
      st.timingSource = prev ? 'upload' : 'estimate'
      if (!prev) delete st.timingsFor
      let match: any
      if (prev) { // word timings from Whisper on the PC: the voice must say the script word for word
        const heard = prev.map((w) => w.w).join(' ')
        match = matchTranscript(input.story, heard)
        if (!match.ok) issues.push(`voice does not match the script word for word (${match.edits} edits, WER ${match.wer}); re-take it`)
      }
      st.voice = { file, url: publish(run, file, `voice.${file.split('.').pop()}`, `${input.title} · voiceover`, 'voice', { engine }), engine, seconds: +seconds.toFixed(2), uploaded: !!up || (!!keep && !!st.voice?.uploaded), match, sha }
      const warnings = [...notes, ...issues]
      return { issues, text: `Voice: ${engine}, ${st.voice.seconds}s, timings from ${st.timingSource}${warnings.length ? '\n- ' + warnings.join('\n- ') : ''}`, data: { voice: st.voice, timings: st.timings, warnings } }
    }
    case 'images': {
      need('plan', 'plan')
      const out: State['images'] = []
      for (const shot of st.plan!.shots) {
        const up = uploaded(run.id, 'image', shot.n, 'png')
        const file = `${dir}/shot-${shot.n}.png`
        let source = 'storyboard'
        let note = 'drawn stand-in, not a generated illustration'
        if (up) {
          copyFileSync(up, file)
          source = 'upload'
          note = ''
        } else if (process.env.LOCAL_IMAGE_ENDPOINT) {
          const local = await fetchLocalImage(shot.picture, input.w, input.h)
          if ('offline' in local) {
            writeFileSync(file, await storyboardFrame(shot, input.cast, input.w, input.h))
            note = 'Local image worker offline. This frame is a drawn stand-in, not a generated illustration.'
          } else {
            writeFileSync(file, await sharp(local.png).resize(input.w, input.h, { fit: 'cover', position: 'centre' }).png().toBuffer())
            source = 'local'
            note = 'local worker'
          }
        } else writeFileSync(file, await storyboardFrame(shot, input.cast, input.w, input.h))
        const check = await checkPicture(file, input.w, input.h)
        out.push({ n: shot.n, source, note, check, url: publish(run, file, `shot-${shot.n}.png`, `${input.title} · shot ${shot.n}`, 'images', { prompt: shot.picture, shot: shot.n, source, note }) })
      }
      st.images = out
      const issues = out.flatMap((i) => i.check.issues.map((x) => `shot ${i.n}: ${x}`))
      return { issues, text: out.map((i) => `${i.n}. ${i.source}${i.note ? ' (' + i.note + ')' : ''} ${i.check.ok ? 'ok' : i.check.issues.join('; ')}`).join('\n'), data: { images: out } }
    }
    case 'clips': {
      need('images', 'images'); need('timings', 'voice')
      const total = (st.voice?.seconds || st.plan!.estSeconds) + 0.3
      st.cuts = cutTimes(st.plan!, st.timings!, total)
      const out: State['clips'] = []
      for (const shot of st.plan!.shots) {
        const cut = st.cuts.find((c) => c.n === shot.n)!
        const len = Math.max(0.5, cut.end - cut.start)
        const up = uploaded(run.id, 'clip', shot.n, 'mp4')
        const file = `${dir}/shot-${shot.n}.mp4`
        if (up) copyFileSync(up, file)
        else { const r = await clipFromImage(`${dir}/shot-${shot.n}.png`, file, shot.motion, +(len + 0.1).toFixed(2), input.w, input.h, input.fps); if (r.code) throw new Error(`clip ${shot.n}: ${r.err.slice(-400)}`) }
        const check = await checkClip(file, input.w, input.h, up ? Math.min(1, len) : len * 0.9)
        out.push({ n: shot.n, source: up ? 'upload' : 'camera-move', check, url: publish(run, file, `shot-${shot.n}.mp4`, `${input.title} · clip ${shot.n}`, 'clips', { motion: shot.motion, shot: shot.n }) })
      }
      st.clips = out
      const issues = out.flatMap((c) => c.check.issues.map((x) => `clip ${c.n}: ${x}`))
      return { issues, text: out.map((c) => `${c.n}. ${c.source} ${c.check.stats.seconds?.toFixed?.(2)}s drift ${c.check.stats.drift} ${c.check.ok ? 'ok' : c.check.issues.join('; ')}`).join('\n'), data: { clips: out, cuts: st.cuts } }
    }
    case 'sfx': {
      need('plan', 'plan')
      const out: State['sfx'] = []
      for (const shot of st.plan!.shots) {
        const file = `${dir}/sfx-${shot.n}.wav`
        const up = uploaded(run.id, 'sfx', shot.n, 'wav')
        if (up) copyFileSync(up, file); else { const r = await makeSfx(shot.sfx, file); if (r.code) throw new Error(`sfx ${shot.n}: ${r.err.slice(-300)}`) }
        out.push({ n: shot.n, tag: up ? 'upload' : shot.sfx, url: publish(run, file, `sfx-${shot.n}.wav`, `${input.title} · sfx ${shot.n} (${shot.sfx})`, 'sfx', { shot: shot.n }) })
      }
      st.sfx = out
      return { issues: [], text: out.map((s) => `${s.n}. ${s.tag}`).join('\n'), data: { sfx: out } }
    }
    case 'edit': {
      need('clips', 'clips'); need('sfx', 'sfx'); need('voice', 'voice')
      writeFileSync(`${dir}/captions.ass`, captionsAss(st.timings!, input.w, input.h))
      const segments = st.cuts!.map((c) => ({ clip: `shot-${c.n}.mp4`, start: c.start, end: c.end, sfx: `sfx-${c.n}.wav` }))
      const r = await finalEdit({ cwd: dir, segments, voice: st.voice!.file.split('/').pop()!, captions: 'captions.ass', out: 'final.mp4', w: input.w, h: input.h, fps: input.fps })
      if (r.code) throw new Error('edit failed: ' + r.err.slice(-600))
      const seconds = await duration(`${dir}/final.mp4`), lufs = await loudness(`${dir}/final.mp4`)
      st.final = { seconds: +seconds.toFixed(2), lufs, url: publish(run, `${dir}/final.mp4`, 'final.mp4', `${input.title} · final short`, 'edit', { seconds, lufs }) }
      return { issues: [], text: `Final short ${st.final.seconds}s, ${lufs} LUFS\n\n${readFileSync(`${dir}/captions.ass`, 'utf8')}`, data: { final: st.final, segments } }
    }
    case 'qa': {
      need('final', 'edit')
      const issues: string[] = [], warn: string[] = []
      st.drift = cutDrift(st.cuts!)
      if (st.drift > 0.25) issues.push(`cuts land ${st.drift}s from the first word on average (rule E1 wants ≤0.25s)`)
      const l = st.final!.lufs
      if (st.voice?.engine !== 'silent-guide') { if (l == null || l < -16 || l > -12) issues.push(`loudness ${l} LUFS is outside -16..-12 (rule A1)`) } else warn.push('silent guide voice: loudness not checked')
      if (Math.abs(st.final!.seconds - (st.voice!.seconds + 0.3)) > 1) issues.push(`final length ${st.final!.seconds}s doesn't match the voice (${st.voice!.seconds}s)`)
      if (!st.verify?.ok) issues.push('plan check did not pass')
      if (st.timingSource !== 'upload') warn.push('word timings are estimated; upload Whisper word timings for exact cuts and captions')
      for (const x of st.images || []) if (x.source === 'storyboard') { warn.push(x.note || 'images: drawn stand-in, not a generated illustration'); break }
      for (const x of st.clips || []) if (x.source !== 'upload') { warn.push('clips: CPU camera move, not a generated video'); break }
      st.qa = { ok: issues.length === 0, issues, stats: { drift: st.drift, lufs: l, seconds: st.final!.seconds, voice: st.voice!.engine, timings: st.timingSource, warnings: warn } }
      return { issues, text: `QA ${st.qa.ok ? 'passed' : 'failed'}\n${[...issues, ...warn.map((w) => 'note: ' + w)].map((x) => '- ' + x).join('\n')}\nWatch it back: ${st.final!.url}`, data: { qa: st.qa } }
    }
  }
}

const running = new Map<string, Promise<void>>()
async function execute(id: string, from: Stage, until: Stage) {
  const run = load(id)!; const input = parse(run.input, {}) as Input; const st = parse(run.state, { stages: {} }) as State
  const order = STAGES.slice(STAGES.indexOf(from), STAGES.indexOf(until) + 1)
  try {
    for (const stage of order) {
      save(id, { status: 'running', stage })
      const t0 = Date.now()
      const r = await runStage(run, input, st, stage)
      const strictBlock = r.issues.length > 0 && (input.strict || stage === 'plan')
      const libraryId = saveStage(run, stage, r.text, r.data)
      st.stages[stage] = { status: strictBlock ? 'blocked' : 'done', at: now(), issues: r.issues, libraryId, seconds: +((Date.now() - t0) / 1000).toFixed(1) }
      save(id, { state: st })
      appendRecord('shorts.stage', { runId: id, stage, ok: !r.issues.length, issues: r.issues.slice(0, 5), libraryId }, { userId: run.user_id, agentId: 'shorts' })
      if (strictBlock && stage !== 'qa') { save(id, { status: 'blocked', error: `${stage}: ${r.issues.slice(0, 3).join('; ')}` }); return }
    }
    const qaFail = st.stages.qa && st.qa && !st.qa.ok
    save(id, { status: until === 'qa' ? (qaFail ? 'failed_qa' : 'done') : 'paused', stage: until, error: qaFail ? st.qa!.issues.join('; ') : null })
  } catch (e: any) {
    const stage = (load(id)?.stage || from) as Stage
    st.stages[stage] = { status: 'error', at: now(), issues: [e.message] }
    save(id, { status: 'error', error: e.message.slice(0, 1000), state: st })
    appendRecord('shorts.error', { runId: id, stage, error: e.message.slice(0, 300) }, { userId: run.user_id, agentId: 'shorts' })
  }
}
const asStage = (s: any, d: Stage): Stage => (STAGES as readonly string[]).includes(s) ? s : d
function start(id: string, userId: string, from?: any, until?: any) {
  if (running.has(id)) throw new Error('this run is already running')
  if ([...running.keys()].some((k) => load(k)?.user_id === userId)) throw new Error('a shorts run is already rendering for you; wait for it to finish')
  if (running.size >= Number(process.env.SHORTS_MAX_CONCURRENT || 1)) throw new Error('the renderer is busy; try again in a minute')
  const row = load(id, userId)!; const st = parse(row.state, { stages: {} }) as State
  const firstTodo = STAGES.find((s) => st.stages[s]?.status !== 'done') || 'script'
  const f = asStage(from, firstTodo), u = asStage(until, 'qa')
  if (STAGES.indexOf(f) > STAGES.indexOf(u)) throw new Error(`"from" (${f}) comes after "until" (${u})`)
  save(id, { status: 'running', stage: f, error: null })
  const p = execute(id, f, u).finally(() => running.delete(id))
  running.set(id, p)
  return { runId: id, status: 'running', from: f, until: u, poll: `/api/shorts/runs/${id}` }
}
async function wait(id: string, ms = 170_000) { const p = running.get(id); if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]) }

export function createRun(userId: string, body: any) {
  const input = normInput(body)
  const id = 'sht_' + randomUUID().slice(0, 12)
  db.prepare("insert into shorts_runs(id,user_id,title,status,stage,input,state,created_at,updated_at) values(?,?,?,'new',null,?,?,?,?)").run(id, userId, input.title, JSON.stringify(input), JSON.stringify({ stages: {} }), now(), now())
  appendRecord('shorts.create', { runId: id, title: input.title, words: input.story.split(/\s+/).length }, { userId, agentId: 'shorts' })
  return id
}
export const getRun = (userId: string, id: string) => { const r = load(id, userId); return r ? view(r) : null }
export const listRuns = (userId: string) => (db.prepare('select id,title,status,stage,error,created_at,updated_at from shorts_runs where user_id=? order by created_at desc limit 50').all(userId) as any[])
  .map((r) => ({ id: r.id, title: r.title, status: r.status, stage: r.stage, error: r.error || undefined, createdAt: r.created_at, updatedAt: r.updated_at }))

// Invalidate a stage and everything after it (e.g. after uploading a better picture or editing the plan).
function invalidateFrom(id: string, stage: Stage, opts: { dropTimings?: boolean } = {}) {
  const r = load(id)!; const st = parse(r.state, { stages: {} }) as State
  for (const s of STAGES.slice(STAGES.indexOf(stage))) delete st.stages[s]
  if (opts.dropTimings && st.timingSource === 'upload') { delete st.timings; delete st.timingSource; delete st.timingsFor } // a new take needs new timings
  save(id, { state: st, status: r.status === 'running' ? r.status : 'paused' })
}

// ---------- agent tools ----------
const tools: Tool[] = [
  {
    name: 'shorts_plan', risk: 'safe', description: 'Plan a faceless cartoon story short from a narration (word for word): checks the script (length, hook, "you"), splits it into shots with picture prompts, camera moves, sound ideas and cast, and verifies the plan. Nothing is rendered.',
    parameters: { type: 'object', properties: { story: { type: 'string' }, title: { type: 'string' }, shots: { type: 'integer', minimum: 3, maximum: 20 } }, required: ['story'] },
    async run(a) { const i = normInput(a); const plan = buildPlan({ ...i }); return { check: checkScript(i.story), plan, verify: verifyPlan(plan, i.story, i.cast) } }
  },
  {
    name: 'shorts_make', risk: 'approval', description: 'Render a vertical story short offline (voice, storyboard pictures, camera-move clips, synthesized sound effects, captions, loudness) as a staged run; each stage is checked and saved to the Library. "until" stops early (e.g. "images" to check pictures before clips). Requires approval.',
    parameters: { type: 'object', properties: { story: { type: 'string' }, title: { type: 'string' }, until: { type: 'string', enum: [...STAGES] } }, required: ['story'] },
    async run(a, c) {
      const id = createRun(c.userId, a); start(id, c.userId, 'script', a.until); await wait(id)
      const r: any = getRun(c.userId, id)
      return { runId: id, status: r?.status, error: r?.error, final: r?.final?.url, qa: r?.qa, stages: Object.fromEntries(Object.entries(r?.stages || {}).map(([k, v]: any) => [k, v.status])) }
    }
  }
]
export function initShorts() { registerTools(tools) }

// ---------- routes ----------
export function registerShortsRoutes(app: FastifyInstance) {
  const uid = (req: any) => String(req.userId)
  const fail = (reply: any, e: any, code = 400) => reply.status(code).send({ error: String(e?.message || e) })
  const own = (req: any, reply: any) => { const r = load((req.params as any).id, uid(req)); if (!r) reply.status(404).send({ error: 'Not found' }); return r }

  app.get('/api/shorts/status', async () => ({ tools: await toolStatus(), stages: STAGES, motions: MOTIONS, sfx: SFX_TAGS, rules: DEFAULT_RULES, cast: DEFAULT_CAST, busy: running.size }))
  app.post('/api/shorts/plan', async (req, reply) => {
    try { const i = normInput(req.body || {}); const plan = buildPlan({ ...i }); return { check: checkScript(i.story, i), plan, verify: verifyPlan(plan, i.story, i.cast) } } catch (e) { return fail(reply, e) }
  })
  app.post('/api/shorts/runs', async (req, reply) => {
    try {
      const b: any = req.body || {}
      const id = createRun(uid(req), b)
      if (b.until === 'none') return getRun(uid(req), id)
      start(id, uid(req), 'script', b.until)
      if ((req.query as any).wait) { await wait(id); return getRun(uid(req), id) }
      return { runId: id, status: 'running', poll: `/api/shorts/runs/${id}` }
    } catch (e) { return fail(reply, e) }
  })
  app.get('/api/shorts/runs', async (req) => listRuns(uid(req)))
  app.get('/api/shorts/runs/:id', async (req, reply) => { const r = own(req, reply); return r ? view(r) : reply })
  app.post('/api/shorts/runs/:id/run', async (req, reply) => {
    const r = own(req, reply); if (!r) return reply
    try {
      const b: any = req.body || {}
      if (b.from) invalidateFrom(r.id, asStage(b.from, 'script'))
      const s = start(r.id, uid(req), b.from, b.until)
      if ((req.query as any).wait) { await wait(r.id); return getRun(uid(req), r.id) }
      return s
    } catch (e) { return fail(reply, e, 409) }
  })
  // Edit shots (remake a failing plan line by line); the narration itself can't change here, it's verified word for word.
  app.patch('/api/shorts/runs/:id/plan', async (req, reply) => {
    const r = own(req, reply); if (!r) return reply
    if (running.has(r.id)) return fail(reply, 'run is rendering', 409)
    const st = parse(r.state, { stages: {} }) as State; const input = parse(r.input, {}) as Input
    if (!st.plan) return fail(reply, 'run the plan stage first')
    for (const u of ((req.body as any)?.shots || []) as any[]) {
      const s = st.plan.shots.find((x) => x.n === Number(u.n)); if (!s) continue
      if (u.picture) s.picture = String(u.picture).slice(0, 1500)
      if (u.motion && (MOTIONS as readonly string[]).includes(u.motion)) s.motion = u.motion
      if (u.sfx) s.sfx = String(u.sfx).slice(0, 40)
      if (Array.isArray(u.cast)) s.cast = u.cast.map(String).slice(0, 3)
      if (typeof u.text === 'string') s.text = u.text
    }
    st.verify = verifyPlan(st.plan, input.story, input.cast)
    for (const s of STAGES.slice(STAGES.indexOf('plan'))) delete st.stages[s]
    save(r.id, { state: st, status: 'paused' })
    return { plan: st.plan, verify: st.verify }
  })
  // Upload a per-shot render from the PC/Pi (GPU picture, image-to-video clip, voice take, sound effect).
  app.post('/api/shorts/runs/:id/assets/:kind/:n', async (req, reply) => {
    const r = own(req, reply); if (!r) return reply
    const { kind, n } = req.params as any
    const ext = ({ image: ['png'], clip: ['mp4'], voice: ['wav', 'mp3'], sfx: ['wav'] } as Record<string, string[]>)[kind]
    if (!ext) return fail(reply, 'kind must be image, clip, voice or sfx')
    if (!/^\d{1,2}$/.test(String(n))) return fail(reply, 'n must be the shot number (0 for voice)')
    if (running.has(r.id)) return fail(reply, 'run is rendering', 409)
    let buf: Buffer | null = null, name = ''
    try {
      if ((req as any).isMultipart()) { const f = await (req as any).file(); if (f) { buf = await f.toBuffer(); name = f.filename || '' } }
      else { const b: any = req.body || {}; if (b.base64) { buf = Buffer.from(String(b.base64), 'base64'); name = String(b.name || '') } }
    } catch (e) { return fail(reply, e) }
    if (!buf?.length) return fail(reply, 'file (multipart) or {base64} required')
    let e = (name.split('.').pop() || '').toLowerCase(); if (!ext.includes(e)) e = ext[0]
    mkdirSync(workDir(r.id), { recursive: true })
    for (const x of ext) rmSync(`${workDir(r.id)}/upload-${kind}-${n}.${x}`, { force: true })
    writeFileSync(`${workDir(r.id)}/upload-${kind}-${n}.${e}`, buf)
    if (kind === 'image') { const input = parse(r.input, {}) as Input; const c = await checkPicture(`${workDir(r.id)}/upload-${kind}-${n}.${e}`, input.w, input.h).catch((x) => ({ ok: false, issues: [String(x.message)], stats: {} })); invalidateFrom(r.id, 'images'); return { ok: true, check: c } }
    invalidateFrom(r.id, ({ clip: 'clips', voice: 'voice', sfx: 'sfx' } as Record<string, Stage>)[kind], { dropTimings: kind === 'voice' })
    return { ok: true, bytes: buf.length }
  })
  // Word timings from faster-whisper (word_timestamps=True) on the PC: [{w,start,end}]
  app.post('/api/shorts/runs/:id/timings', async (req, reply) => {
    const r = own(req, reply); if (!r) return reply
    const ws = ((req.body as any)?.words || []) as any[]
    const words: Word[] = ws.map((w) => ({ w: String(w.w ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) })).filter((w) => w.w && Number.isFinite(w.start) && w.end >= w.start)
    if (!words.length) return fail(reply, 'words [{w,start,end}] required')
    const st = parse(r.state, { stages: {} }) as State; const input = parse(r.input, {}) as Input
    // the timings are for the take the next voice stage will use: a pending upload, else the current voice file
    const take = uploadedVoice(r.id) || (st.voice?.file && existsSync(st.voice.file) ? st.voice.file : null)
    if (!take) return fail(reply, 'no voice take yet: run the voice stage or upload a voice first')
    st.timings = words; st.timingSource = 'upload'; st.timingsFor = fileSha(take)
    for (const s of STAGES.slice(STAGES.indexOf('voice'))) delete st.stages[s]
    save(r.id, { state: st, status: 'paused' })
    return { ok: true, words: words.length, match: matchTranscript(input.story, words.map((w) => w.w).join(' ')) }
  })
  app.delete('/api/shorts/runs/:id', async (req, reply) => {
    const r = own(req, reply); if (!r) return reply
    if (running.has(r.id)) return fail(reply, 'run is rendering', 409)
    db.prepare('delete from shorts_runs where id=?').run(r.id)
    rmSync(workDir(r.id), { recursive: true, force: true }) // work files only; published outputs + Library items are kept
    return { ok: true }
  })
  // Stage 0 "study": measure a reference short and save a contact sheet + numbers, to derive or tune the rulebook.
  app.post('/api/shorts/study', async (req, reply) => {
    if (!(req as any).isMultipart()) return fail(reply, 'multipart video file required')
    if (running.size >= Number(process.env.SHORTS_MAX_CONCURRENT || 1)) return fail(reply, 'the renderer is busy; try again in a minute', 409)
    const f = await (req as any).file(); if (!f) return fail(reply, 'file required')
    const id = 'ref_' + randomUUID().slice(0, 12), dir = workDir(id)
    mkdirSync(dir, { recursive: true })
    const src = `${dir}/ref.${(f.filename || 'v.mp4').split('.').pop()!.replace(/[^\w]/g, '') || 'mp4'}`
    writeFileSync(src, await f.toBuffer())
    try {
      const m = await studyReference(src, `${dir}/sheet.png`)
      const fake = { id, user_id: uid(req), title: `Reference ${f.filename || id}` } as Row
      const sheet = existsSync(`${dir}/sheet.png`) ? publish(fake, `${dir}/sheet.png`, 'sheet.png', `${fake.title} · 8 stills`, 'script', { study: true }) : null
      const text = `${fake.title}: ${m.seconds}s, ${m.vertical ? 'vertical' : 'horizontal'}, ${m.shots} shots (avg ${m.avgShotSeconds}s), ${m.lufs} LUFS, warmth ${m.warmth}`
      const libraryId = upsertItem({ type: 'pipeline', sourceId: `shorts:${id}:study`, userId: uid(req), agentId: 'shorts', title: `${fake.title} · study`, preview: text, body: text, tags: ['shorts', 'study'], meta: { study: true }, snapshot: { text, data: { ...m, sheet } } })
      appendRecord('shorts.study', { refId: id, ...m }, { userId: uid(req), agentId: 'shorts' })
      return { id, ...m, sheet, libraryId }
    } catch (e) { return fail(reply, e, 500) } finally { rmSync(src, { force: true }) }
  })
}
