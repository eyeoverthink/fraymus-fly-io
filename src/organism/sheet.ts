// Read-only 16×8 sheet. Natural frequencies are fixed; initial phases come from an explicit seed.
// Nothing here starts a timer. Callers increment the integer clock and own the interval.
export const COLS = 16
export const ROWS = 8
export const CELLS = COLS * ROWS
export const PHI = 1.618033988749895
export const DT = 0.05
export const STEP_MS = 80
export const LOCAL_J = 0.65
export const COUPLING_K = 1.85

const TAU = Math.PI * 2

export type Sheet = {
  phases: Float64Array
  freqs: Float64Array
  potentials: Float64Array
  orderR: number
  meanPhase: number
  clock: number
}

export function naturalFrequency(col: number, row: number): number {
  return 1 + 0.25 * Math.sin((col + row * PHI) * 0.4)
}

export function neighborIndex(row: number, col: number, dir: 'up' | 'down' | 'left' | 'right'): number {
  if (dir === 'up') return ((row - 1 + ROWS) % ROWS) * COLS + col
  if (dir === 'down') return ((row + 1) % ROWS) * COLS + col
  if (dir === 'left') return row * COLS + ((col - 1 + COLS) % COLS)
  return row * COLS + ((col + 1) % COLS)
}

function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function wrapPhase(x: number): number {
  if (!Number.isFinite(x)) return 0
  let y = x % TAU
  if (y < 0) y += TAU
  return y
}

function measure(phases: ArrayLike<number>): { orderR: number; meanPhase: number } {
  let sumCos = 0
  let sumSin = 0
  for (let i = 0; i < CELLS; i++) {
    const p = wrapPhase(phases[i])
    sumCos += Math.cos(p)
    sumSin += Math.sin(p)
  }
  let orderR = Math.hypot(sumCos, sumSin) / CELLS
  if (!Number.isFinite(orderR)) orderR = 0
  orderR = Math.min(1, Math.max(0, orderR))
  let meanPhase = Math.atan2(sumSin, sumCos)
  if (!Number.isFinite(meanPhase)) meanPhase = 0
  return { orderR, meanPhase }
}

export function createSheet(seed = 1): Sheet {
  const phases = new Float64Array(CELLS)
  const freqs = new Float64Array(CELLS)
  const potentials = new Float64Array(CELLS)
  const rand = mulberry32(seed)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c
      phases[i] = rand() * TAU
      freqs[i] = naturalFrequency(c, r)
      potentials[i] = Math.sin(phases[i])
    }
  }
  const { orderR, meanPhase } = measure(phases)
  return { phases, freqs, potentials, orderR, meanPhase, clock: 0 }
}

/** One integration step. Does not advance `clock` and does not mutate the input phase buffer. */
export function stepSheet(sheet: Sheet): Sheet {
  const prev = sheet.phases
  const next = new Float64Array(CELLS)
  const potentials = new Float64Array(CELLS)
  const { orderR, meanPhase } = measure(prev)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c
      const theta = wrapPhase(prev[idx])
      const local = Math.sin(wrapPhase(prev[neighborIndex(r, c, 'up')]) - theta)
        + Math.sin(wrapPhase(prev[neighborIndex(r, c, 'down')]) - theta)
        + Math.sin(wrapPhase(prev[neighborIndex(r, c, 'left')]) - theta)
        + Math.sin(wrapPhase(prev[neighborIndex(r, c, 'right')]) - theta)
      const global = orderR * Math.sin(meanPhase - theta)
      const freq = Number.isFinite(sheet.freqs[idx]) ? sheet.freqs[idx] : naturalFrequency(c, r)
      const updated = wrapPhase(theta + (freq + LOCAL_J * 0.25 * local + COUPLING_K * global) * DT)
      next[idx] = updated
      const pot = Math.sin(updated) * 0.7 + Math.cos(updated * PHI) * 0.3
      potentials[idx] = Number.isFinite(pot) ? Math.max(-1, Math.min(1, pot)) : 0
    }
  }
  const measured = measure(next)
  return {
    phases: next,
    freqs: sheet.freqs,
    potentials,
    orderR: measured.orderR,
    meanPhase: measured.meanPhase,
    clock: Number.isFinite(sheet.clock) ? Math.trunc(sheet.clock) : 0
  }
}

/** Caller-owned clock. The step function never calls this. */
export function advanceClock(sheet: Sheet): Sheet {
  const clock = Number.isFinite(sheet.clock) ? Math.trunc(sheet.clock) + 1 : 1
  return { ...sheet, clock }
}

export function shouldAnimate(opts: { paused?: boolean; reducedMotion?: boolean }): boolean {
  return !opts.paused && !opts.reducedMotion
}

let activeTimers = 0
export function activeSheetTimers(): number { return activeTimers }

/** Starts an interval only when called. `stop` is safe to call more than once. */
export function startSheetTimer(onTick: () => void, intervalMs = STEP_MS): { stop: () => void } {
  const ms = Number.isFinite(intervalMs) && intervalMs >= 1 ? intervalMs : STEP_MS
  activeTimers++
  let stopped = false
  const id = setInterval(() => { if (!stopped) onTick() }, ms)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(id)
      activeTimers--
    }
  }
}

export function bindSheetAnimation(onFrame: (sheet: Sheet) => void, opts: { sheet: Sheet; paused?: boolean; reducedMotion?: boolean; intervalMs?: number }): { stop: () => void } {
  if (!shouldAnimate(opts)) return { stop() {} }
  let current = opts.sheet
  const timer = startSheetTimer(() => {
    current = advanceClock(stepSheet(current))
    onFrame(current)
  }, opts.intervalMs)
  return { stop: () => timer.stop() }
}

type DrawCtx = {
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect: (x: number, y: number, w: number, h: number) => void
  fillRect: (x: number, y: number, w: number, h: number) => void
}

/** Decorative cell colors. The numbers a person reads are text beside the canvas, not this color. */
export function drawCells(ctx: DrawCtx, sheet: Sheet, width: number, height: number) {
  ctx.clearRect(0, 0, width, height)
  const cw = width / COLS
  const ch = height / ROWS
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = sheet.potentials[r * COLS + c]
      const t = Number.isFinite(p) ? Math.max(0, Math.min(1, (p + 1) / 2)) : 0
      const g = Math.round(40 + 180 * t)
      ctx.fillStyle = `rgb(${g}, ${Math.round(80 + 40 * t)}, ${Math.round(120 + 80 * (1 - t))})`
      ctx.fillRect(c * cw, r * ch, Math.max(0, cw - 1), Math.max(0, ch - 1))
    }
  }
}
