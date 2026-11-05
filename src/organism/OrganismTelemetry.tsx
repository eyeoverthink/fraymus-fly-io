import { useEffect, useRef, useState } from 'react'
import { bindSheetAnimation, createSheet, drawCells, shouldAnimate, type Sheet } from './sheet'
import { modelLabel, telemetryLines, type RealCounts } from './telemetry'

export type OrganismTelemetryProps = {
  agents?: number
  tools?: number
  conversations?: number
  providers?: { name?: string; configured?: boolean }[] | null
  mockFallback?: boolean
  runStatus?: string | null
  reducedMotion?: boolean
}

function usePrefersReducedMotion(override: boolean | undefined): boolean {
  const [reduced, setReduced] = useState(() => {
    if (override !== undefined) return override
    if (typeof matchMedia !== 'function') return false
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (override !== undefined) { setReduced(override); return }
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [override])
  return reduced
}

export default function OrganismTelemetry(props: OrganismTelemetryProps) {
  const reduced = usePrefersReducedMotion(props.reducedMotion)
  const [paused, setPaused] = useState(false)
  const sheetRef = useRef<Sheet | null>(null)
  if (!sheetRef.current) sheetRef.current = createSheet(1)
  const [sheet, setSheet] = useState<Sheet>(sheetRef.current)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const bound = bindSheetAnimation((next) => {
      sheetRef.current = next
      setSheet(next)
    }, { sheet: sheetRef.current!, paused, reducedMotion: reduced })
    return () => bound.stop()
  }, [paused, reduced])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    drawCells(ctx, sheet, canvas.width, canvas.height)
  }, [sheet])

  const real: RealCounts = {
    agents: props.agents ?? 0,
    tools: props.tools ?? 0,
    conversations: props.conversations ?? 0,
    runStatus: props.runStatus || 'idle',
    model: modelLabel({ providers: props.providers, mockFallback: props.mockFallback })
  }
  const lines = telemetryLines(real, sheet, { reducedMotion: reduced })
  const animating = shouldAnimate({ paused, reducedMotion: reduced })

  return (
    <section aria-label="Organism telemetry" style={{ borderBottom: '1px solid #222', padding: 12, display: 'flex', flexWrap: 'wrap', gap: 12, background: '#0c0c0c' }}>
      <canvas ref={canvasRef} width={320} height={160} aria-hidden="true" style={{ width: 320, maxWidth: '100%', height: 160, background: '#050505', borderRadius: 8 }} />
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <strong style={{ fontSize: 12 }}>Organism telemetry</strong>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            disabled={reduced}
            aria-pressed={paused || reduced}
            style={{ fontSize: 11, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 6, padding: '4px 8px', cursor: reduced ? 'not-allowed' : 'pointer' }}
          >
            {reduced ? 'Paused (reduced motion)' : paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: '#d4d4d4', margin: '6px 0' }}>Simulated sheet dynamics. This is not a task success score.</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
          {lines.map((line) => (
            <li key={line.kind + ':' + line.text} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: '#888' }}>{line.kind === 'real' ? 'Live' : 'Simulated'}</span>
              {' '}
              {line.text}
            </li>
          ))}
        </ul>
        <p style={{ fontSize: 11, color: '#d4d4d4', margin: '6px 0 0' }}>
          {animating ? 'Animation running.' : reduced ? 'Motion reduced. The sheet is not animating.' : 'Animation paused.'}
        </p>
      </div>
    </section>
  )
}
