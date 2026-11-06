// Story Shorts: the offline media half. Everything here is free and local: FFmpeg (clips, sound effects, edit,
// captions, loudness), sharp (storyboard frames, picture checks), espeak-ng or Piper (voice). No network calls.
// GPU-only stages (diffusion pictures, image-to-video) run on the PC/Pi/VPS and are uploaded as assets instead.
import { spawn } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import sharp from 'sharp'
import type { CastMember, Motion, Shot } from './plan'

export type Exec = { code: number; out: string; err: string; buf?: Buffer }
export function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<Exec> {
  return new Promise((res) => {
    let err = '', size = 0
    const bufs: Buffer[] = []
    let p: ReturnType<typeof spawn>
    try { p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e: any) { return res({ code: -1, out: '', err: e.message }) }
    const t = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, opts.timeoutMs ?? 10 * 60_000)
    const done = (code: number, extra = '') => { clearTimeout(t); const buf = Buffer.concat(bufs); res({ code, out: buf.toString(), err: err + extra, buf }) }
    p.stdout!.on('data', (d: Buffer) => { if (size < 8e6) { bufs.push(d); size += d.length } })
    p.stderr!.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6) })
    p.on('error', (e) => done(-1, e.message))
    p.on('close', (code) => done(code ?? -1))
    p.stdin!.on('error', () => {})
    if (opts.input != null) p.stdin!.end(opts.input); else p.stdin!.end()
  })
}
const FF = () => process.env.FFMPEG_BIN || 'ffmpeg'
const FP = () => process.env.FFPROBE_BIN || 'ffprobe'
const THREADS = () => process.env.SHORTS_FFMPEG_THREADS || '2' // the Fly machine has 2 shared CPUs / 2 GB
const ff = (args: string[], cwd?: string, timeoutMs?: number) => sh(FF(), ['-hide_banner', '-y', '-loglevel', 'error', ...args], { cwd, timeoutMs })
const tail = (s: string, n = 600) => s.slice(-n)

const probes = new Map<string, boolean>()
export async function hasBin(bin: string, arg = '-version') {
  if (!probes.has(bin)) probes.set(bin, (await sh(bin, [arg], { timeoutMs: 8000 })).code === 0)
  return probes.get(bin)!
}
export async function toolStatus() {
  const model = process.env.PIPER_MODEL
  const piper = !!(model && existsSync(model) && existsSync(model + '.json') && await hasBin(process.env.PIPER_BIN || 'piper', '--help'))
  const espeak = await hasBin(process.env.ESPEAK_BIN || 'espeak-ng', '--version')
  return {
    ffmpeg: await hasBin(FF()), ffprobe: await hasBin(FP()), espeak, piper,
    piperVoice: piper ? basename(model!).replace(/\.onnx$/, '') : null,
    voice: piper ? 'piper' : espeak ? 'espeak-ng' : 'silent-guide', // the engine the voice stage will try first
    localImage: process.env.LOCAL_IMAGE_ENDPOINT ? 'configured' : 'off'
  }
}

export async function duration(file: string): Promise<number> {
  const r = await sh(FP(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 30_000 })
  const d = Number(r.out.trim())
  return Number.isFinite(d) ? d : 0
}
export async function videoInfo(file: string) {
  const r = await sh(FP(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeoutMs: 30_000 })
  const [width, height] = r.out.trim().split(',').map(Number)
  return { width: width || 0, height: height || 0, seconds: await duration(file) }
}

// ---------- pictures ----------
const esc = (s: string) => s.replace(/[<>&"]/g, '')
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const SKIES: [RegExp, [string, string]][] = [[/night|midnight|bunker|dark/i, ['#1d2340', '#5a3d5c']], [/sea|ship|island|warship/i, ['#f6b26b', '#4a7fa7']], [/sunset|evening/i, ['#f9a66c', '#7b4b7a']]]

/** Offline storyboard frame in the target style (flat round-headed cast, painted backdrop, warm light, clear lower third, no text). */
export async function storyboardFrame(shot: Shot, cast: CastMember[], w = 1080, h = 1920): Promise<Buffer> {
  const [top, bottom] = SKIES.find(([re]) => re.test(shot.text))?.[1] || ['#f3c98b', '#7a5a43']
  const r = hash(shot.text)
  const members = shot.cast.map((id) => cast.find((c) => c.id === id)).filter(Boolean) as CastMember[]
  const hills = Array.from({ length: 4 }, (_, i) => {
    const y = h * (0.5 + i * 0.07), a = 60 + ((r >> i) % 120)
    return `<path d="M0 ${y} Q ${w * 0.3} ${y - a} ${w * 0.55} ${y} T ${w} ${y - a / 2} V ${h} H 0 Z" fill="${['#8a6a4f', '#6f5640', '#5a4634', '#47382a'][i]}" opacity="0.9"/>`
  }).join('')
  const props = Array.from({ length: 6 }, (_, i) => { const x = ((r >> (i * 3)) % 100) / 100 * w, y = h * (0.42 + ((r >> i) % 10) / 100); return `<rect x="${x}" y="${y}" width="${40 + i * 12}" height="${80 + i * 20}" rx="10" fill="#3d2f24" opacity="0.55"/>` }).join('')
  const n = members.length || 1
  const figs = members.map((c, i) => {
    const cx = (w / (n + 1)) * (i + 1), headR = c.main ? w * 0.12 : w * 0.09, cy = h * 0.36 + (c.main ? 0 : headR * 0.4)
    const body = c.palette[0] || '#9be3c3', acc = c.palette[1] || '#d33'
    const mouth = shot.feeling === 'scared' ? `<ellipse cx="${cx}" cy="${cy + headR * 0.42}" rx="${headR * 0.12}" ry="${headR * 0.16}" fill="#222"/>`
      : shot.feeling === 'smug' ? `<path d="M${cx - headR * 0.3} ${cy + headR * 0.4} Q ${cx} ${cy + headR * 0.5} ${cx + headR * 0.35} ${cy + headR * 0.3}" stroke="#222" stroke-width="8" fill="none"/>`
      : `<path d="M${cx - headR * 0.3} ${cy + headR * 0.38} Q ${cx} ${cy + headR * 0.58} ${cx + headR * 0.3} ${cy + headR * 0.38}" stroke="#222" stroke-width="8" fill="none"/>`
    return `<g><line x1="${cx}" y1="${cy + headR}" x2="${cx}" y2="${cy + headR * 2.6}" stroke="${body}" stroke-width="${headR * 0.5}" stroke-linecap="round"/>
      <line x1="${cx}" y1="${cy + headR * 1.4}" x2="${cx - headR}" y2="${cy + headR * 2}" stroke="#222" stroke-width="10" stroke-linecap="round"/>
      <line x1="${cx}" y1="${cy + headR * 1.4}" x2="${cx + headR}" y2="${cy + headR * 2}" stroke="#222" stroke-width="10" stroke-linecap="round"/>
      <line x1="${cx}" y1="${cy + headR * 2.6}" x2="${cx - headR * 0.5}" y2="${cy + headR * 3.4}" stroke="#222" stroke-width="10" stroke-linecap="round"/>
      <line x1="${cx}" y1="${cy + headR * 2.6}" x2="${cx + headR * 0.5}" y2="${cy + headR * 3.4}" stroke="#222" stroke-width="10" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="${headR}" fill="${body}" stroke="#222" stroke-width="6"/>
      <rect x="${cx - headR * 0.8}" y="${cy + headR * 0.85}" width="${headR * 1.6}" height="${headR * 0.3}" rx="${headR * 0.15}" fill="${acc}"/>
      <circle cx="${cx - headR * 0.35}" cy="${cy - headR * 0.1}" r="${headR * 0.09}" fill="#222"/><circle cx="${cx + headR * 0.35}" cy="${cy - headR * 0.1}" r="${headR * 0.09}" fill="#222"/>${mouth}</g>`
  }).join('')
  const lx = w * (0.15 + ((r % 70) / 100))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#ffe7a3" stop-opacity="0.95"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/><circle cx="${lx}" cy="${h * 0.12}" r="${w * 0.35}" fill="url(#glow)"/>
  <line x1="${lx}" y1="0" x2="${lx}" y2="${h * 0.1}" stroke="#333" stroke-width="4"/><circle cx="${lx}" cy="${h * 0.12}" r="${w * 0.03}" fill="#fff3c4"/>
  ${props}${hills}${figs}<desc>${esc(shot.picture).slice(0, 500)}</desc></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** Picture check against the measurable rules: 9:16, not a plain background, warm light, lower third free of the brightest detail. */
export async function checkPicture(file: string, w = 1080, h = 1920) {
  const issues: string[] = []
  const img = sharp(file)
  const meta = await img.metadata()
  const aspect = (meta.width || 1) / (meta.height || 1)
  if (Math.abs(aspect - w / h) > 0.02) issues.push(`aspect ${meta.width}x${meta.height}, expected ${w}:${h}`)
  const st = await img.clone().stats()
  const sd = st.channels.slice(0, 3).reduce((t, c) => t + c.stdev, 0) / 3
  if (sd < 12) issues.push('looks like a plain background (rule S1)')
  const [R, , B] = st.channels.map((c) => c.mean)
  if (R < B) issues.push('no warm light: blue outweighs red (rule S2)')
  return { ok: issues.length === 0, issues, stats: { width: meta.width, height: meta.height, stdev: +sd.toFixed(1), warmth: +(R - B).toFixed(1) } }
}

// ---------- clips ----------
/** Still -> moving clip with a camera move (Ken Burns), the CPU-only stand-in for image-to-video. */
export async function clipFromImage(img: string, out: string, motion: Motion, seconds = 4, w = 1080, h = 1920, fps = 30): Promise<Exec> {
  const frames = Math.max(1, Math.round(seconds * fps))
  const W = Math.round(w * 1.25 / 2) * 2, H = Math.round(h * 1.25 / 2) * 2 // modest oversample: smooth enough, light on a 2 GB machine
  const z = { 'push-in': `1+0.12*on/${frames}`, 'pull-out': `1.12-0.12*on/${frames}` }[motion as string] || '1.1'
  const x = { 'pan-left': `(iw-iw/zoom)*(1-on/${frames})`, 'pan-right': `(iw-iw/zoom)*on/${frames}` }[motion as string] || '(iw-iw/zoom)/2'
  const y = { 'tilt-up': `(ih-ih/zoom)*(1-on/${frames})`, 'tilt-down': `(ih-ih/zoom)*on/${frames}` }[motion as string] || '(ih-ih/zoom)/2'
  const vf = motion === 'hold' ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps}`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps}`
  return ff(['-threads', THREADS(), '-loop', '1', '-i', img, '-vf', vf + ',format=yuv420p', '-t', String(seconds), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-x264-params', 'rc-lookahead=10', '-an', out], undefined, 5 * 60_000)
}

/** Clip check: size, length, and how much the picture changes between start and end (identity drift proxy). */
export async function checkClip(file: string, w = 1080, h = 1920, minSeconds = 1) {
  const issues: string[] = []
  const v = await videoInfo(file)
  if (v.width !== w || v.height !== h) issues.push(`clip is ${v.width}x${v.height}, expected ${w}x${h}`)
  if (v.seconds < minSeconds) issues.push(`clip is ${v.seconds.toFixed(2)}s, under ${minSeconds}s`)
  const grab = async (t: number) => (await sh(FF(), ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=36:64,format=gray', '-f', 'rawvideo', '-'], { timeoutMs: 30_000 })).buf || Buffer.alloc(0)
  let drift = 0
  try {
    const a = await grab(0.1), b = await grab(v.seconds - 0.2)
    if (a.length && a.length === b.length) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); drift = +(s / a.length / 255).toFixed(3) }
  } catch {}
  const maxDrift = Number(process.env.SHORTS_MAX_CLIP_DRIFT || 0.35)
  if (drift > maxDrift) issues.push(`picture changes too much within the shot (${drift} > ${maxDrift}); characters may not stay themselves`)
  return { ok: issues.length === 0, issues, stats: { ...v, drift } }
}

// ---------- voice ----------
/** Offline narration: Piper (natural neural voice, CPU, ~100 MB RAM) if a voice model is configured, else espeak-ng,
 *  else a silent guide track. A failed engine falls through to the next one and the reason is returned as `fallback`. */
export async function synthVoice(text: string, out: string, estSeconds: number): Promise<{ engine: string; seconds: number; err?: string; fallback?: string }> {
  const t = await toolStatus()
  const fell: string[] = []
  const good = () => existsSync(out) && statSync(out).size > 1000
  if (t.piper) {
    rmSync(out, { force: true })
    // Piper (medium voice) runs ~20x faster than real time on CPU and needs ~100-200 MB, fine on the 2 GB machine
    const args = ['--model', process.env.PIPER_MODEL!, '--output_file', out, '--sentence_silence', process.env.PIPER_SENTENCE_SILENCE || '0.25']
    if (process.env.PIPER_LENGTH_SCALE) args.push('--length_scale', process.env.PIPER_LENGTH_SCALE)
    const r = await sh(process.env.PIPER_BIN || 'piper', args, { input: text.replace(/\s+/g, ' ').trim() + '\n', timeoutMs: 5 * 60_000 })
    if (r.code === 0 && good()) { const seconds = await duration(out); if (seconds > 0) return { engine: 'piper', seconds } }
    fell.push(`piper failed (exit ${r.code}): ${tail(r.err, 200).trim()}`)
  }
  if (t.espeak) {
    rmSync(out, { force: true })
    const r = await sh(process.env.ESPEAK_BIN || 'espeak-ng', ['-v', process.env.ESPEAK_VOICE || 'en-us', '-s', process.env.ESPEAK_WPM || '165', '-w', out, text], { timeoutMs: 2 * 60_000 })
    if (r.code === 0 && good()) return { engine: 'espeak-ng', seconds: await duration(out), fallback: fell.join('; ') || undefined }
    fell.push(`espeak-ng failed (exit ${r.code})`)
  }
  const r = await ff(['-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`, '-t', estSeconds.toFixed(2), out])
  return { engine: 'silent-guide', seconds: r.code === 0 ? await duration(out) : estSeconds, err: r.code ? tail(r.err) : undefined, fallback: fell.join('; ') || undefined }
}

// ---------- sound effects ----------
const SFX_SRC: Record<string, string> = {
  bang: 'anoisesrc=d=0.6:c=brown:a=0.9,lowpass=f=900,afade=t=out:st=0.04:d=0.5',
  waves: 'anoisesrc=d=3:c=pink:a=0.5,lowpass=f=600,tremolo=f=0.4:d=0.8,afade=t=in:d=0.5,afade=t=out:st=2.4:d=0.6',
  beep: 'sine=f=880:d=0.9,volume=0.6,apulsator=hz=4:mode=square',
  crowd: 'anoisesrc=d=2.5:c=pink:a=0.4,bandpass=f=900:w=600,tremolo=f=3:d=0.5,afade=t=in:d=0.4,afade=t=out:st=2:d=0.5',
  coin: 'sine=f=2400:d=0.35,afade=t=out:st=0.02:d=0.33',
  hum: 'sine=f=60:d=3,volume=0.5,afade=t=in:d=0.4,afade=t=out:st=2.4:d=0.6',
  whoosh: 'anoisesrc=d=0.8:c=white:a=0.5,highpass=f=1200,afade=t=in:d=0.35,afade=t=out:st=0.4:d=0.4',
  'soft room tone': 'anoisesrc=d=2:c=brown:a=0.08,lowpass=f=300'
}
export const SFX_TAGS = Object.keys(SFX_SRC)
/** Synthesised (license-free) sound effect for a shot's sound idea. */
export async function makeSfx(tag: string, out: string): Promise<Exec> {
  const src = SFX_SRC[tag] || SFX_SRC['soft room tone']
  return ff(['-f', 'lavfi', '-i', src, '-ar', '44100', '-ac', '1', out])
}

// ---------- edit ----------
export type Segment = { clip: string; start: number; end: number; sfx?: string }
/** Final edit: plain cuts at the given times, captions burned in, narration + low sfx, loudness-normalised for shorts. */
export async function finalEdit(o: { cwd: string; segments: Segment[]; voice: string; captions: string; out: string; w?: number; h?: number; fps?: number; lufs?: number; sfxGain?: number }): Promise<Exec> {
  const w = o.w || 1080, h = o.h || 1920, fps = o.fps || 30
  const args: string[] = ['-threads', THREADS()]
  o.segments.forEach((s) => args.push('-stream_loop', '-1', '-t', (s.end - s.start).toFixed(3), '-i', s.clip))
  args.push('-i', o.voice)
  const sfxIdx: { i: number; at: number }[] = []
  o.segments.forEach((s) => { if (s.sfx && existsSync(`${o.cwd}/${s.sfx}`)) { sfxIdx.push({ i: o.segments.length + 1 + sfxIdx.length, at: s.start }); args.push('-i', s.sfx) } })
  const n = o.segments.length, vi = n
  const v = o.segments.map((s, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},setsar=1,trim=duration=${(s.end - s.start).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`).join(';')
  const cat = `${o.segments.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vc];[vc]subtitles=${o.captions}[vout]`
  const fx = sfxIdx.map((s, k) => `[${s.i}:a]adelay=${Math.round(s.at * 1000)}:all=1,volume=${o.sfxGain ?? 0.25}[s${k}]`).join(';')
  const mix = `[${vi}:a]aformat=channel_layouts=mono,volume=1[vo];${fx ? fx + ';' : ''}[vo]${sfxIdx.map((_, k) => `[s${k}]`).join('')}amix=inputs=${1 + sfxIdx.length}:duration=first:normalize=0,loudnorm=I=${o.lufs ?? -14}:TP=-1.5:LRA=11,aresample=44100[aout]`
  args.push('-filter_complex', `${v};${cat};${mix}`, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-x264-params', 'rc-lookahead=10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', o.out)
  return ff(args, o.cwd, 20 * 60_000)
}

/** Integrated loudness (LUFS) of a file's audio, measured with FFmpeg's EBU R128 scanner. */
export async function loudness(file: string): Promise<number | null> {
  // Plain `ebur128` (no framelog=quiet: FFmpeg 5.1 in Debian bookworm rejects that value and then prints a bogus 0.0 summary).
  // Read the integrated value from the final summary block only, and only when FFmpeg finished cleanly.
  const r = await sh(FF(), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 })
  if (r.code !== 0) return null
  const m = [...r.err.matchAll(/Integrated loudness:\s*\n\s*I:\s+(-?[\d.]+) LUFS/g)].pop()
  return m ? Number(m[1]) : null
}

/** Stage "study": measure a reference short (length, cut rate, loudness, warmth) and keep a contact sheet of 8 stills. */
export async function studyReference(file: string, sheetOut: string) {
  const v = await videoInfo(file)
  const sc = await sh(FF(), ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'], { timeoutMs: 5 * 60_000 })
  const cuts = (sc.err.match(/pts_time:/g) || []).length
  const sheet = await ff(['-i', file, '-vf', `fps=${(8 / Math.max(1, v.seconds)).toFixed(4)},scale=270:-2,tile=4x2`, '-frames:v', '1', sheetOut], undefined, 5 * 60_000)
  let warmth: number | null = null
  if (sheet.code === 0 && existsSync(sheetOut)) { const st = await sharp(sheetOut).stats(); warmth = +(st.channels[0].mean - st.channels[2].mean).toFixed(1) }
  const lufs = await loudness(file)
  const shots = cuts + 1
  return { seconds: +v.seconds.toFixed(2), width: v.width, height: v.height, vertical: v.height > v.width, shots, avgShotSeconds: +(v.seconds / shots).toFixed(2), lufs, warmth, sheet: sheet.code === 0 }
}
