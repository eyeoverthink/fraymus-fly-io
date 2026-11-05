// Labels for the telemetry panel. Simulated sheet numbers and live agent counts stay in separate lines.
export type RealCounts = {
  agents: number
  tools: number
  conversations: number
  runStatus: string
  model: string
}

export type TelemetryLine = { kind: 'real' | 'simulated'; text: string }

function count(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0
}

export function modelLabel(input: { providers?: { name?: string; configured?: boolean }[] | null; mockFallback?: boolean } | null | undefined): string {
  if (!input) return 'unavailable'
  if (input.mockFallback) return 'offline stand-in'
  const names = (input.providers || []).map((p) => (p?.configured && p.name ? p.name : '')).filter(Boolean)
  return names.length ? names.join(', ') : 'unavailable'
}

export function telemetryLines(real: RealCounts, sim: { orderR: number; meanPhase: number; clock: number }, opts: { reducedMotion?: boolean } = {}): TelemetryLine[] {
  const run = String(real.runStatus || 'idle').replace(/\s+/g, ' ').trim() || 'idle'
  const lines: TelemetryLine[] = [
    { kind: 'simulated', text: 'Sheet dynamics' },
    { kind: 'simulated', text: 'Not a task success score' },
    { kind: 'simulated', text: `Synchrony ${Math.min(1, Math.max(0, finite(sim.orderR))).toFixed(3)} of 1` },
    { kind: 'simulated', text: `Mean phase ${finite(sim.meanPhase).toFixed(3)} radians` },
    { kind: 'simulated', text: `Sheet clock ${Number.isFinite(sim.clock) ? Math.trunc(sim.clock) : 0}` },
    { kind: 'real', text: 'Counts are agent status' },
    { kind: 'real', text: `Agents ${count(real.agents)}` },
    { kind: 'real', text: `Tools ${count(real.tools)}` },
    { kind: 'real', text: `Conversations ${count(real.conversations)}` },
    { kind: 'real', text: `Run ${run}` },
    { kind: 'real', text: `Model ${real.model || 'unavailable'}` }
  ]
  if (opts.reducedMotion) lines.push({ kind: 'simulated', text: 'Motion reduced' })
  return lines
}

/** The panel is shown only when the authenticated status payload says so. */
export function showOrganismTelemetry(status: { organismTelemetry?: unknown } | null | undefined): boolean {
  return status?.organismTelemetry === true
}
