// Explicit opt-in flags. Absent, empty, and any value other than on / 1 / true stay off.
export function envFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true'
}

export const organismTelemetryEnabled = () => envFlag(process.env.ORGANISM_TELEMETRY)
export const memoryNgramEnabled = () => envFlag(process.env.MEMORY_NGRAM)
