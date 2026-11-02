// Story Shorts: the pure (no I/O) half of the pipeline. Rulebook, cast bible, script checks, shot planner,
// plan verifier, word timings, cut placement and captions. Abstracted from a "faceless cartoon story short"
// workflow: study references -> rules -> cast -> script -> plan N shots -> voice -> pictures -> clips -> sfx -> edit -> QA.
// Every function here is deterministic so it can be unit-checked and re-run without cost.

export type Rule = { id: string; area: 'character' | 'scene' | 'story' | 'edit' | 'audio'; text: string; check?: string }
export type CastMember = { id: string; name: string; role: string; look: string; palette: string[]; main?: boolean }
export type Shot = { n: number; text: string; picture: string; motion: Motion; sfx: string; cast: string[]; feeling: string }
export type Plan = { title: string; style: string; shots: Shot[]; words: number; estSeconds: number }
export type Word = { w: string; start: number; end: number }
export type Check = { ok: boolean; issues: string[]; stats: Record<string, any> }

export const MOTIONS = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'hold'] as const
export type Motion = typeof MOTIONS[number]
export const WPS = 2.6 // narration speed (words / second) used for estimates before a real voice exists

// Generic rulebook distilled from the reference workflow. Users can replace or extend it per channel.
export const DEFAULT_RULES: Rule[] = [
  { id: 'C1', area: 'character', text: 'One main character in most shots; never more than 3 characters in a shot.', check: 'maxCastPerShot=3' },
  { id: 'C2', area: 'character', text: 'Simple flat characters: big round heads, dot eyes, line mouth, no nose, stick limbs.' },
  { id: 'C3', area: 'character', text: 'Each shot shows one clear feeling (scared, smug, hopeful...).', check: 'feelingPerShot' },
  { id: 'C4', area: 'character', text: 'Same cast and same look in every shot (use the character sheets).' },
  { id: 'C5', area: 'character', text: 'Original characters only: nothing from shows, films, games or other channels.' },
  { id: 'S1', area: 'scene', text: 'Detailed painted scenes, never a plain background.' },
  { id: 'S2', area: 'scene', text: 'A visible warm light source in every scene (hanging bulb, lamp, sunset).' },
  { id: 'S3', area: 'scene', text: 'Period-accurate props and places; no anachronisms (flags, buildings, plants).' },
  { id: 'S4', area: 'scene', text: 'No readable text, numbers or dates drawn into pictures.' },
  { id: 'S5', area: 'scene', text: 'Faces sit in the upper two thirds; the bottom third is kept clear for captions.' },
  { id: 'T1', area: 'story', text: 'A true, strange story about one main character, told to the viewer as "you".' },
  { id: 'T2', area: 'story', text: 'Hook in the first 3 seconds.', check: 'hookSeconds<=3' },
  { id: 'T3', area: 'story', text: 'Two to four quick steps, then the twist; stop right after the twist.' },
  { id: 'T4', area: 'story', text: 'At least two picture jokes: the picture shows exactly what the words say.' },
  { id: 'T5', area: 'story', text: 'Runs about 40-45 seconds.', check: 'seconds=35..50' },
  { id: 'E1', area: 'edit', text: 'Plain cuts between shots, no transitions; each cut lands just before its first word.', check: 'cutDrift<=0.25' },
  { id: 'E2', area: 'edit', text: 'Big captions in the lower third, word-for-word with the narration.' },
  { id: 'A1', area: 'audio', text: 'Narration plus low sound effects, no music; loud enough for shorts (about -14 LUFS).', check: 'lufs=-16..-12' }
]

// Placeholder cast; replace with your own originals (the planner only needs id, name, role and look).
export const DEFAULT_CAST: CastMember[] = [
  { id: 'hero', name: 'Hero', role: 'curious, slightly nervous main character', look: 'mint green body, one curl of hair like a question mark, red and white striped scarf', palette: ['#9be3c3', '#d33', '#fff'], main: true },
  { id: 'prof', name: 'Professor', role: 'explains things', look: 'tall, round glasses, brown tweed coat', palette: ['#8a5a3c', '#f2e2c4'] },
  { id: 'strong', name: 'Strongman', role: 'big gentle helper', look: 'huge round torso, tiny head, blue singlet', palette: ['#3a6ea5', '#f0c27b'] },
  { id: 'kid', name: 'Kid', role: 'cheeky kid', look: 'orange puffer jacket, two hair bunches', palette: ['#f28c28', '#3b2a1a'] },
  { id: 'rich', name: 'Rich Man', role: 'smug rich man', look: 'top hat, monocle, purple coat', palette: ['#5b2a86', '#e8c547'] }
]

const FEELINGS: [RegExp, string][] = [
  [/\b(shoot|shot|war|attack|missile|launch|fire|danger|alarm|warning)\b/i, 'scared'], [/\b(refus|nobody|nothing|calm|wait)\w*/i, 'calm'],
  [/\b(win|won|rich|sold|offer|money|\$\d)/i, 'smug'], [/\b(strange|odd|weird|off|but)\b/i, 'puzzled'], [/\b(turns out|only|twist|actually)\b/i, 'surprised']
]
const SFX: [RegExp, string][] = [
  [/\b(shoot|shot|gun|fire|cannon|bang)\w*/i, 'bang'], [/\b(ship|sea|warship|boat|island)\w*/i, 'waves'], [/\b(computer|screen|alarm|warning|beep|red)\b/i, 'beep'],
  [/\b(crowd|soldiers|troops|army|men)\b/i, 'crowd'], [/\b(money|coin|\$\d|offer|paid|pay)\w*/i, 'coin'], [/\b(night|midnight|quiet|wait)\w*/i, 'hum'],
  [/\b(run|ran|fast|soon|sudden)\w*/i, 'whoosh']
]

export const words = (s: string) => String(s || '').trim().split(/\s+/).filter(Boolean)
export const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}$']/gu, '')

/** Sentence split that keeps "$10.", "Mr.", "1983." etc. intact enough for narration. */
export function sentences(story: string): string[] {
  const text = String(story || '').replace(/\s+/g, ' ').trim()
  if (!text) return []
  const out: string[] = []
  let cur = ''
  const toks = text.split(' ')
  for (let i = 0; i < toks.length; i++) {
    cur += (cur ? ' ' : '') + toks[i]
    const t = toks[i]
    const abbrev = /^(Mr|Mrs|Ms|Dr|St|Sir|Jr|Sr|vs|etc|U\.S|U\.K)\.$/i.test(t)
    if (/[.!?…]["')\]]*$/.test(t) && !abbrev && (i === toks.length - 1 || /^["'(\[]?[\p{Lu}\d$]/u.test(toks[i + 1]))) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}

/** Script check (stage "script"): length, hook timing, viewer address. Runs before any paid or slow step. */
export function checkScript(story: string, opts: { minSeconds?: number; maxSeconds?: number } = {}): Check {
  const w = words(story), s = sentences(story)
  const seconds = +(w.length / WPS).toFixed(1)
  const hookSeconds = +(words(s[0] || '').length / WPS).toFixed(1)
  const issues: string[] = []
  const min = opts.minSeconds ?? 25, max = opts.maxSeconds ?? 60
  if (!w.length) issues.push('script is empty')
  if (seconds < min) issues.push(`script runs ~${seconds}s, under ${min}s`)
  if (seconds > max) issues.push(`script runs ~${seconds}s, over ${max}s`)
  if (hookSeconds > 4) issues.push(`first sentence takes ~${hookSeconds}s; the hook should land within 3s`)
  const you = w.filter((x) => /^(you|your|you're)$/i.test(norm(x))).length
  return { ok: issues.length === 0, issues, stats: { words: w.length, sentences: s.length, seconds, hookSeconds, youCount: you } }
}

/** Split narration into exactly `count` shots on sentence/clause boundaries, never changing a word. */
export function splitShots(story: string, count = 12): string[] {
  let parts = sentences(story)
  if (!parts.length) return []
  count = Math.max(1, Math.min(count, words(story).length))
  // too few sentences: split longest part at a comma/clause, else at its middle word
  while (parts.length < count) {
    let li = 0
    parts.forEach((p, i) => { if (words(p).length > words(parts[li]).length) li = i })
    const ws = words(parts[li])
    if (ws.length < 2) break
    let cut = -1, best = Infinity
    ws.forEach((x, i) => { if (i < ws.length - 1 && /[,;:—–-]$/.test(x)) { const d = Math.abs(i + 1 - ws.length / 2); if (d < best) { best = d; cut = i + 1 } } })
    if (cut < 0) cut = Math.ceil(ws.length / 2)
    parts.splice(li, 1, ws.slice(0, cut).join(' '), ws.slice(cut).join(' '))
  }
  // too many: merge the shortest adjacent pair
  while (parts.length > count) {
    let mi = 0, ml = Infinity
    for (let i = 0; i < parts.length - 1; i++) { const l = words(parts[i]).length + words(parts[i + 1]).length; if (l < ml) { ml = l; mi = i } }
    parts.splice(mi, 2, parts[mi] + ' ' + parts[mi + 1])
  }
  return parts
}

const pick = <T>(table: [RegExp, T][], text: string, d: T) => table.find(([re]) => re.test(text))?.[1] ?? d

/** Stage "plan": shot list with narration, picture prompt, motion, sound idea and cast per shot. */
export function buildPlan(input: { title?: string; story: string; shots?: number; cast?: CastMember[]; rules?: Rule[]; style?: string }): Plan {
  const cast = input.cast?.length ? input.cast : DEFAULT_CAST
  const main = cast.find((c) => c.main) || cast[0]
  const style = input.style || 'flat 2D cartoon, simple round-headed characters with dot eyes and no nose, detailed painted background, warm visible light, vertical 9:16'
  const texts = splitShots(input.story, input.shots ?? 12)
  const others = cast.filter((c) => c.id !== main.id)
  const hasMain: boolean[] = []
  const shots: Shot[] = texts.map((text, i) => {
    const named = others.filter((c) => { const first = (c.name.split(' ')[0] || '').slice(0, 64).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return !!first && new RegExp(`\\b${first}\\b`, 'i').test(text) })
    // main character in most shots: skip only on wide "establishing" lines with no person, never twice in a row
    const establishing = i > 0 && /\b(ships?|island|map|satellites?|radar|army|troops|soldiers)\b/i.test(text) && !/\byou\b/i.test(text)
    const prevNoMain = i > 0 && !hasMain[i - 1]
    const withMain = !establishing || prevNoMain
    hasMain[i] = withMain
    const support = named.length ? named : establishing ? [] : others.length ? [others[i % others.length]] : []
    const inShot = [...(withMain ? [main] : []), ...support].slice(0, 3)
    const feeling = pick(FEELINGS, text, i === 0 ? 'curious' : 'focused')
    const motion: Motion = i === 0 ? 'push-in' : i === texts.length - 1 ? 'hold' : MOTIONS[(i % (MOTIONS.length - 1))]
    const who = inShot.map((c) => `${c.name} (${c.look})`).join(', ') || 'no characters, wide establishing view'
    const picture = `${style}. Shows exactly: ${text.replace(/["“”]/g, '')} Characters: ${who}. ${inShot.length ? `Feeling: ${feeling}.` : ''} Warm visible light source. Faces in the upper two thirds, bottom third clear. No text, numbers or dates in the picture.`
    return { n: i + 1, text, picture, motion, sfx: pick(SFX, text, 'soft room tone'), cast: inShot.map((c) => c.id), feeling }
  })
  const w = words(input.story).length
  return { title: input.title || clipTitle(input.story), style, shots, words: w, estSeconds: +(w / WPS).toFixed(1) }
}
const clipTitle = (s: string) => { const t = sentences(s)[0] || 'Story short'; return t.length > 60 ? t.slice(0, 59) + '…' : t }

/** Plan verifier (the "check the plan against the rules before going further" step). */
export function verifyPlan(plan: Plan, story: string, cast: CastMember[] = DEFAULT_CAST): Check {
  const issues: string[] = []
  const a = words(story).map(norm).filter(Boolean), b = plan.shots.flatMap((s) => words(s.text)).map(norm).filter(Boolean)
  let firstDiff = -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { firstDiff = i; break }
  if (firstDiff >= 0) issues.push(`narration differs from the script at word ${firstDiff + 1} ("${a[firstDiff] ?? '∅'}" vs "${b[firstDiff] ?? '∅'}")`)
  const s0 = sentences(story)[0] || '', sl = sentences(story).pop() || ''
  if (plan.shots.length && !norm(plan.shots[0].text).startsWith(norm(words(s0)[0] || ''))) issues.push('first shot does not open on the script\'s opening line')
  if (plan.shots.length && !plan.shots[plan.shots.length - 1].text.trim().endsWith(words(sl).pop() || '')) issues.push('last shot does not finish on the script\'s last sentence')
  const main = (cast.find((c) => c.main) || cast[0])?.id
  const withMain = plan.shots.filter((s) => s.cast.includes(main)).length
  if (plan.shots.length && withMain / plan.shots.length < 0.6) issues.push(`main character in only ${withMain}/${plan.shots.length} shots (rule C1 wants most shots)`)
  for (const s of plan.shots) {
    if (s.cast.length > 3) issues.push(`shot ${s.n}: ${s.cast.length} characters (max 3)`)
    if (!s.picture || !s.motion || !s.sfx) issues.push(`shot ${s.n}: missing picture, motion or sound idea`)
    if (!MOTIONS.includes(s.motion)) issues.push(`shot ${s.n}: unknown motion "${s.motion}"`)
    if (!words(s.text).length) issues.push(`shot ${s.n}: empty narration`)
  }
  const dup = plan.shots.map((s) => norm(s.text)).filter((t, i, arr) => t && arr.indexOf(t) !== i)
  if (dup.length) issues.push(`repeated narration line(s): ${dup.length}`)
  return { ok: issues.length === 0, issues, stats: { shots: plan.shots.length, withMain, words: b.length } }
}

/** Word timings from a voice track of known length: proportional to letters, with pauses after punctuation. */
export function estimateTimings(story: string, seconds: number, lead = 0.15): Word[] {
  const ws = words(story)
  const weight = (w: string) => Math.max(2, norm(w).length) + (/[.!?]$/.test(w) ? 6 : /[,;:—–]$/.test(w) ? 3 : 0)
  const total = ws.reduce((t, w) => t + weight(w), 0) || 1
  const span = Math.max(0.1, seconds - lead - 0.1)
  let t = lead
  return ws.map((w) => {
    const d = (weight(w) / total) * span
    const pause = /[.!?]$/.test(w) ? (6 / total) * span : /[,;:—–]$/.test(w) ? (3 / total) * span : 0
    const out = { w, start: +t.toFixed(3), end: +(t + d - pause).toFixed(3) }
    t += d
    return out
  })
}

/** Map each shot to [start,end) on the voice timeline. Cuts land `pre` seconds before the shot's first word. */
export function cutTimes(plan: Plan, timings: Word[], total: number, pre = 0.08) {
  const out: { n: number; start: number; end: number; firstWord: number }[] = []
  let wi = 0
  for (const s of plan.shots) {
    const first = timings[wi]
    out.push({ n: s.n, start: s.n === 1 ? 0 : Math.max(0, +((first?.start ?? 0) - pre).toFixed(3)), end: 0, firstWord: first?.start ?? 0 })
    wi += words(s.text).length
  }
  for (let i = 0; i < out.length; i++) out[i].end = i < out.length - 1 ? out[i + 1].start : +total.toFixed(3)
  return out
}

/** Average distance between each cut and its shot's first word (QA metric "cutDrift"). */
export const cutDrift = (cuts: ReturnType<typeof cutTimes>) => {
  const c = cuts.slice(1)
  return c.length ? +(c.reduce((t, x) => t + Math.abs(x.firstWord - x.start), 0) / c.length).toFixed(3) : 0
}

const assTime = (t: number) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}` }
const assEsc = (s: string) => s.replace(/[{}\\]/g, '').replace(/\n/g, ' ')

/** Big lower-third captions, 2-4 words at a time, timed to the words (ASS for libass). */
export function captionsAss(timings: Word[], w = 1080, h = 1920, perLine = 3): string {
  const size = Math.round(h * 0.05)
  const lines: string[] = []
  for (let i = 0; i < timings.length; i += perLine) {
    const g = timings.slice(i, i + perLine)
    const end = timings[i + perLine]?.start ?? g[g.length - 1].end + 0.3
    lines.push(`Dialogue: 0,${assTime(g[0].start)},${assTime(Math.max(end, g[0].start + 0.2))},Cap,,0,0,0,,${assEsc(g.map((x) => x.w).join(' ').toUpperCase())}`)
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(size / 9)},2,2,60,60,${Math.round(h * 0.2)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`
}

/** Compare a transcript (e.g. faster-whisper of the voice take) with the script: the "every word matched" check. */
export function matchTranscript(script: string, heard: string) {
  const a = words(script).map(norm).filter(Boolean), b = words(heard).map(norm).filter(Boolean)
  // Levenshtein on word arrays (scripts are short)
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  const edits = d[a.length][b.length]
  return { ok: edits === 0, edits, wer: a.length ? +(edits / a.length).toFixed(3) : 0 }
}
