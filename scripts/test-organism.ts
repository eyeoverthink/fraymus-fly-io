// Sheet math, timer ownership, labels, and the default-off Agents panel. No server and no network.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentsPage from '../src/agents/AgentsPage'
import OrganismTelemetry from '../src/organism/OrganismTelemetry'
import {
  CELLS, COLS, COUPLING_K, DT, LOCAL_J, PHI, ROWS, STEP_MS,
  activeSheetTimers, advanceClock, bindSheetAnimation, createSheet, drawCells, naturalFrequency, neighborIndex,
  shouldAnimate, startSheetTimer, stepSheet
} from '../src/organism/sheet'
import { modelLabel, showOrganismTelemetry, telemetryLines } from '../src/organism/telemetry'
import { envFlag, organismTelemetryEnabled } from '../server/lib/flags'

let failures = 0
let passes = 0
const ok = (c: unknown, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TAU = Math.PI * 2

const saved = process.env.ORGANISM_TELEMETRY
delete process.env.ORGANISM_TELEMETRY
ok(envFlag(undefined) === false && envFlag('') === false && envFlag('off') === false && envFlag('yes') === false, 'flag: absent, empty, off, and yes stay off')
ok(envFlag('on') && envFlag('1') && envFlag('true') && envFlag(' ON '), 'flag: on, 1, true, and padded ON are on')
ok(organismTelemetryEnabled() === false, 'ORGANISM_TELEMETRY absent keeps telemetry off')
process.env.ORGANISM_TELEMETRY = 'on'
ok(organismTelemetryEnabled() === true, 'ORGANISM_TELEMETRY=on enables the flag helper')
if (saved === undefined) delete process.env.ORGANISM_TELEMETRY
else process.env.ORGANISM_TELEMETRY = saved

ok(activeSheetTimers() === 0, 'importing the sheet module does not start a timer')
const sheetSrc = readFileSync(new URL('../src/organism/sheet.ts', import.meta.url), 'utf8')
ok((sheetSrc.match(/setInterval\(/g) || []).length === 1, 'the sheet module contains a single setInterval, inside the timer helper')

ok(COLS === 16 && ROWS === 8 && CELLS === 128 && DT === 0.05 && STEP_MS === 80, 'sheet: 16×8, dt 0.05, 80ms step')
ok(neighborIndex(0, 0, 'up') === 7 * COLS && neighborIndex(0, 0, 'left') === 15, 'sheet: toroidal neighbors wrap the corner')
ok(neighborIndex(7, 15, 'down') === 15 && neighborIndex(7, 15, 'right') === 7 * COLS, 'sheet: toroidal neighbors wrap the far corner')

const freqOk = (() => {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const expected = 1 + 0.25 * Math.sin((c + r * PHI) * 0.4)
    if (naturalFrequency(c, r) !== expected) return false
  }
  return true
})()
ok(freqOk, 'sheet: natural frequency is 1+0.25*sin((c+r*PHI)*0.4) with no noise term')

const a = createSheet(42)
const b = createSheet(42)
ok(a.clock === 0 && a.phases.every((p, i) => p === b.phases[i]) && a.freqs.every((f, i) => f === naturalFrequency(i % COLS, Math.floor(i / COLS))), 'sheet: seeded phases and frequencies are deterministic')
ok(createSheet(42).phases.some((p, i) => p !== createSheet(7).phases[i]), 'sheet: a different seed changes the phases')
ok(a.orderR >= 0 && a.orderR <= 1 && Number.isFinite(a.meanPhase), 'sheet: initial synchrony is in 0..1 and mean phase is finite')

const before = Float64Array.from(a.phases)
const stepped = stepSheet(a)
ok(a.phases.every((p, i) => p === before[i]) && stepped.clock === 0, 'sheet: stepSheet does not mutate the input or the clock')
ok(stepSheet({ ...a, clock: 5 }).clock === 5, 'sheet: an existing clock is left for the caller')
let progressed = a
const first: number[] = []
for (let i = 0; i < 25; i++) {
  progressed = stepSheet(progressed)
  first.push(progressed.phases[0])
  if (!(progressed.orderR >= 0 && progressed.orderR <= 1 && Number.isFinite(progressed.meanPhase))) { first.length = 0; break }
  if (progressed.phases.some((p) => !Number.isFinite(p) || p < 0 || p >= TAU)) { first.length = 0; break }
  if (progressed.potentials.some((p) => !Number.isFinite(p) || p < -1 || p > 1)) { first.length = 0; break }
}
let again = createSheet(42)
for (let i = 0; i < 25; i++) again = stepSheet(again)
ok(first.length === 25 && again.phases.every((p, i) => p === progressed.phases[i]), 'sheet: 25 seeded steps stay finite, clamped, and repeatable')
const clocked = advanceClock(advanceClock(progressed))
ok(clocked.clock === 2 && clocked.phases[0] === progressed.phases[0], 'sheet: clock increments only through advanceClock')

const bad = createSheet(1)
bad.phases[0] = Number.NaN
bad.phases[1] = Number.POSITIVE_INFINITY
bad.phases[2] = -100
const repaired = stepSheet(bad)
ok(repaired.phases.every((p) => Number.isFinite(p) && p >= 0 && p < TAU) && repaired.orderR >= 0 && repaired.orderR <= 1 && Number.isFinite(repaired.meanPhase), 'sheet: NaN, infinity, and negative phases become finite wrapped values')

ok(shouldAnimate({}) && !shouldAnimate({ paused: true }) && !shouldAnimate({ reducedMotion: true }) && !shouldAnimate({ paused: true, reducedMotion: true }), 'sheet: animation runs only when it is not paused and motion is allowed')

{
  let ticks = 0
  const timer = startSheetTimer(() => { ticks++ }, 20)
  ok(activeSheetTimers() === 1, 'timer: startSheetTimer is the call that creates the interval')
  await sleep(70)
  timer.stop()
  timer.stop()
  const frozen = ticks
  await sleep(50)
  ok(frozen >= 1 && ticks === frozen && activeSheetTimers() === 0, `timer: pause/stop halts ticks and a second stop is safe (${frozen})`)
}

{
  let frames = 0
  let clock = 0
  const seed = createSheet(3)
  const held = bindSheetAnimation((s) => { frames++; clock = s.clock }, { sheet: seed, paused: true, intervalMs: 15 })
  await sleep(45)
  held.stop()
  ok(frames === 0 && activeSheetTimers() === 0, 'timer: a paused binding does not tick')
  const reduced = bindSheetAnimation(() => { frames++ }, { sheet: seed, reducedMotion: true, intervalMs: 15 })
  await sleep(45)
  reduced.stop()
  ok(frames === 0, 'timer: reduced motion does not tick')
  const running = bindSheetAnimation((s) => { frames++; clock = s.clock }, { sheet: seed, intervalMs: 15 })
  await sleep(50)
  running.stop()
  const n = frames
  await sleep(40)
  ok(n >= 1 && frames === n && clock === n && activeSheetTimers() === 0, `timer: binding advances the clock and cleanup stops it (${n})`)
}

{
  const calls: string[] = []
  const ctx = {
    fillStyle: '',
    clearRect() { calls.push('clear') },
    fillRect() { calls.push('fill') }
  }
  drawCells(ctx, createSheet(1), 320, 160)
  ok(calls[0] === 'clear' && calls.filter((c) => c === 'fill').length === CELLS, 'draw: one rectangle per cell, labels are not encoded as color')
}

const lines = telemetryLines(
  { agents: 4, tools: 9, conversations: 2, runStatus: 'running', model: 'offline stand-in' },
  { orderR: 0.25, meanPhase: 1.5, clock: 3 },
  { reducedMotion: true }
)
const text = lines.map((l) => `${l.kind}:${l.text}`).join('\n')
ok(text.includes('simulated:Sheet dynamics') && text.includes('simulated:Not a task success score') && text.includes('simulated:Motion reduced'), 'labels: simulated dynamics are named and are not a success score')
ok(text.includes('real:Counts are agent status') && text.includes('real:Agents 4') && text.includes('real:Tools 9') && text.includes('real:Conversations 2') && text.includes('real:Run running') && text.includes('simulated:Synchrony 0.250 of 1'), 'labels: live counts and synchrony are written as text')
ok(modelLabel({ mockFallback: true, providers: [{ name: 'ollama', configured: true }] }) === 'offline stand-in', 'labels: the offline stand-in is named')
ok(modelLabel({ providers: [{ name: 'ollama', configured: true }, { name: 'groq', configured: false }] }) === 'ollama', 'labels: only configured providers are listed')
ok(showOrganismTelemetry(null) === false && showOrganismTelemetry({}) === false && showOrganismTelemetry({ organismTelemetry: false }) === false && showOrganismTelemetry({ organismTelemetry: 'on' }) === false, 'panel: hidden unless the status flag is boolean true')
ok(showOrganismTelemetry({ organismTelemetry: true }) === true, 'panel: shown when status says true')

const hidden = renderToStaticMarkup(createElement(AgentsPage))
ok(!hidden.includes('Organism telemetry') && !hidden.includes('Simulated sheet dynamics'), 'panel: the Agents page does not render telemetry before a true flag')
const shown = renderToStaticMarkup(createElement(OrganismTelemetry, { agents: 4, tools: 9, conversations: 2, mockFallback: true, runStatus: 'idle', reducedMotion: true }))
ok(shown.includes('Organism telemetry') && shown.includes('Simulated sheet dynamics') && shown.includes('not a task success score') && shown.includes('>Live<') && shown.includes('Agents 4') && shown.includes('Paused (reduced motion)') && shown.includes('Motion reduced'), 'panel: reduced-motion markup has text labels, live counts, and a paused control')
const moving = renderToStaticMarkup(createElement(OrganismTelemetry, { agents: 1, tools: 2, conversations: 0, providers: [{ name: 'ollama', configured: true }], runStatus: 'idle', reducedMotion: false }))
ok(moving.includes('>Pause<') && !moving.includes('Motion reduced') && moving.includes('Model ollama'), 'panel: with motion allowed the control is Pause and the model is named')

console.log(failures ? `\n${failures} organism check(s) FAILED` : `\nall ${passes} organism checks passed`)
process.exit(failures ? 1 : 0)
