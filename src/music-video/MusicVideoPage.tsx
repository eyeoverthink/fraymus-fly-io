import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { apiFetch, errorText } from '../lib/api'
import { toast } from '../components/Toasts'

type FileOut = { name: string; kind: string; label: string; url: string; libraryId?: string; bytes?: number }
type Job = {
  id: string; title: string; status: string; stage?: string; progress?: number; shot?: number | null; shots?: number | null
  error?: string; mode?: string; input?: any; files?: FileOut[]
}
type Status = { mode: 'mock' | 'live'; reachable: boolean; recipe: string; recipeReady: boolean; message: string }
type Listed = { id: string; title: string; status: string; createdAt: number }

const field = { width: '100%', boxSizing: 'border-box' as const, background: '#0e0e0e', color: '#e8e8e8', border: '1px solid #2a2a2a', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 13 }
const label: CSSProperties = { display: 'block', fontSize: 10, letterSpacing: '0.12em', color: '#8d8d8d', margin: '14px 0 6px' }
const ghost: CSSProperties = { font: 'inherit', fontSize: 12, background: '#161616', color: '#ddd', border: '1px solid #2e2e2e', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }

const get = async (url: string) => {
  const r = await apiFetch(url)
  if (!r.ok) throw new Error(await errorText(r))
  return r.json()
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map(([v, text]) => (
        <button type="button" key={v} onClick={() => onChange(v)} style={{ flex: 1, border: 0, borderRadius: 6, padding: '7px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12, background: value === v ? '#f4f4f4' : 'transparent', color: value === v ? '#111' : '#9a9a9a', fontWeight: 650 }}>{text}</button>
      ))}
    </div>
  )
}

export default function MusicVideoPage({ onOpenLibrary }: { onOpenLibrary?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [recent, setRecent] = useState<Listed[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [song, setSong] = useState<File | null>(null)
  const [character, setCharacter] = useState('')
  const [picture, setPicture] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [storyline, setStoryline] = useState('')
  const [aspect, setAspect] = useState<'16:9' | '9:16'>('16:9')
  const [backend, setBackend] = useState<'hf' | 'comfy'>('hf')
  const [lyrics, setLyrics] = useState(true)
  const [consent, setConsent] = useState(false)
  const [formError, setFormError] = useState('')
  const [pick, setPick] = useState('master')
  const [redoN, setRedoN] = useState('1')
  const [redoNote, setRedoNote] = useState('')
  const [shotlist, setShotlist] = useState('')

  const selected = useRef<string | null>(null)
  const loadRecent = useCallback(() => get('/api/music-video/jobs').then((d) => setRecent(d.jobs || [])).catch(() => {}), [])
  const openJob = useCallback((id: string) => {
    selected.current = id
    return get('/api/music-video/jobs/' + id).then((j) => { if (selected.current === id) setJob(j); return j }).catch((e) => { if (selected.current === id) toast('error', e.message) })
  }, [])

  useEffect(() => {
    get('/api/music-video/status').then(setStatus).catch((e) => setStatus({ mode: 'live', reachable: false, recipe: 'anime-mv', recipeReady: false, message: e.message }))
    loadRecent()
  }, [loadRecent])

  useEffect(() => {
    if (!picture) { setPreview(''); return }
    const url = URL.createObjectURL(picture)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [picture])

  const running = job?.status === 'queued' || job?.status === 'running' || job?.status === 'submitting'
  useEffect(() => {
    if (!job || !running) return
    const t = setInterval(() => openJob(job.id), 1500)
    return () => clearInterval(t)
  }, [job?.id, running, openJob])

  useEffect(() => { if (job && !running) loadRecent() }, [job?.id, job?.status, running, loadRecent])

  const videos = useMemo(() => (job?.files || []).filter((f) => f.kind === 'master' || f.kind === 'lyrics' || f.kind === 'phone'), [job])
  const active = videos.find((f) => f.kind === pick) || videos[0]
  const contact = job?.files?.find((f) => f.kind === 'contact')
  const listFile = job?.files?.find((f) => f.kind === 'shotlist')

  useEffect(() => {
    if (!listFile) { setShotlist(''); return }
    let stop = false
    apiFetch(listFile.url).then((r) => r.text()).then((t) => { if (!stop) setShotlist(t) }).catch(() => {})
    return () => { stop = true }
  }, [listFile?.url])

  const make = async (e: FormEvent) => {
    e.preventDefault()
    setFormError('')
    if (!song) return setFormError('Choose a song.')
    if (!character.trim() && !picture) return setFormError('Describe the character, or add a picture.')
    if (!storyline.trim()) return setFormError('Write a storyline.')
    if (!consent) return setFormError('Confirm you have the rights to the song and the character.')
    if (status && status.mode === 'live' && !status.reachable) return setFormError(status.message)
    const body = new FormData()
    body.append('song', song)
    body.append('storyline', storyline.trim())
    body.append('aspect', aspect)
    body.append('backend', backend)
    body.append('lyrics', lyrics ? 'true' : 'false')
    body.append('style', 'anime')
    body.append('consent', 'true')
    if (character.trim()) body.append('character', character.trim())
    if (picture) body.append('character_image', picture)
    setBusy(true)
    try {
      const r = await apiFetch('/api/music-video/jobs', { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } })
      if (!r.ok) throw new Error(await errorText(r))
      const created = await r.json()
      setRedoNote('')
      setPick('master')
      await openJob(created.id)
      loadRecent()
    } catch (err: any) {
      setFormError(err.message)
      toast('error', err.message)
    } finally { setBusy(false) }
  }

  const redo = async () => {
    if (!job) return
    const r = await apiFetch(`/api/music-video/jobs/${job.id}/redo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shot: Number(redoN) }) })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) return toast('error', body.error || 'Redo failed')
    if (!body.supported) { setRedoNote(body.message || 'Redo is not available on this studio.'); return }
    setRedoNote('')
    openJob(job.id)
  }

  const remove = async () => {
    if (!job || !confirm(`Remove “${job.title}” from this list? Files already in the Library stay there.`)) return
    const id = job.id
    const r = await apiFetch('/api/music-video/jobs/' + id, { method: 'DELETE' })
    if (!r.ok) return toast('error', await errorText(r))
    if (selected.current === id) { selected.current = null; setJob(null) }
    loadRecent()
  }

  const pct = Math.round(Math.max(0, Math.min(1, job?.progress || 0)) * 100)
  const shotLine = job?.shot && job?.shots ? `Shot ${job.shot} of ${job.shots}` : job?.status === 'queued' ? 'Queued' : ''

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#0a0a0a', color: '#e8e8e8' }}>
      <style>{`.mv-grid{display:grid;grid-template-columns:minmax(300px,400px) minmax(0,1fr);gap:28px;align-items:start}.mv-grid textarea{resize:vertical} @media(max-width:860px){.mv-grid{grid-template-columns:1fr}}`}</style>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '22px 22px 48px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'baseline', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.4 }}>Music video</div>
            <div style={{ color: '#8d8d8d', fontSize: 12, marginTop: 4 }}>One character. Your song. The studio cuts the video.</div>
          </div>
          {onOpenLibrary && <button type="button" style={ghost} onClick={onOpenLibrary}>Library</button>}
        </div>

        {status && (status.mode === 'mock' || !status.reachable || status.recipeReady === false) && (
          <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.45, background: status.reachable ? '#141414' : '#2a1414', color: status.reachable ? '#bdbdbd' : '#f0c8c8', border: `1px solid ${status.reachable ? '#2a2a2a' : '#5c2a2a'}` }}>
            {status.message}
          </div>
        )}

        <div className="mv-grid">
          <form onSubmit={make}>
            <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid #222', marginBottom: 8 }}>
              <img src="/mv-example.jpg" alt="Contact sheet from a finished video: one character in the rain, soft and reflective" style={{ width: '100%', height: 176, objectFit: 'cover', display: 'block' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '22px 12px 8px', background: 'linear-gradient(transparent, rgba(0,0,0,.78))', fontSize: 10, letterSpacing: '0.14em', color: '#ddd' }}>EXAMPLE · ONE CHARACTER · RAIN</div>
            </div>

            <span style={label}>SONG</span>
            <label style={{ ...field, display: 'block', cursor: 'pointer' }}>
              <span style={{ color: song ? '#eee' : '#9a9a9a' }}>{song ? song.name : 'Choose an audio file'}</span>
              <input type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/flac,audio/ogg,.mp3,.wav,.m4a,.flac,.ogg" style={{ display: 'none' }} onChange={(e) => setSong(e.target.files?.[0] || null)} />
              <div style={{ color: '#6f6f6f', fontSize: 11, marginTop: 4 }}>MP3, WAV, M4A, FLAC, or OGG · up to 50 MB</div>
            </label>

            <span style={label}>CHARACTER</span>
            <textarea value={character} onChange={(e) => setCharacter(e.target.value)} rows={3} placeholder="Black hair, cream sweater, quiet, standing by a window at night" style={field} />
            <label style={{ ...field, display: 'block', cursor: 'pointer', marginTop: 8 }}>
              <span style={{ color: picture ? '#eee' : '#9a9a9a' }}>{picture ? picture.name : 'Picture, optional'}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => setPicture(e.target.files?.[0] || null)} />
            </label>
            {preview && <img src={preview} alt="" style={{ marginTop: 8, width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #2a2a2a' }} />}

            <span style={label}>STORYLINE</span>
            <textarea value={storyline} onChange={(e) => setStoryline(e.target.value)} rows={5} placeholder={'A short paragraph, or one beat per line.\nShe waits by the window.\nRain on the glass.'} style={field} />

            <span style={label}>ASPECT</span>
            <Seg value={aspect} onChange={(v) => setAspect(v as '16:9' | '9:16')} options={[['16:9', '16:9'], ['9:16', '9:16 phone']]} />
            <span style={label}>BACKEND</span>
            <Seg value={backend} onChange={(v) => setBackend(v as 'hf' | 'comfy')} options={[['hf', 'Hugging Face'], ['comfy', 'Comfy']]} />
            <div style={{ fontSize: 11, color: '#6f6f6f', marginTop: 6 }}>Style is anime. The studio keeps one character across the shots.</div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={lyrics} onChange={(e) => setLyrics(e.target.checked)} /> Lyrics master as well as the clean cut
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 12, color: '#c8c8c8', cursor: 'pointer', lineHeight: 1.4 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
              I have the rights to this song, and this character is mine or I have permission to use their likeness.
            </label>

            {formError && <div style={{ color: '#f0a8a8', fontSize: 12, marginTop: 12 }}>{formError}</div>}
            <button type="submit" disabled={busy} style={{ marginTop: 16, width: '100%', background: '#f4f4f4', color: '#111', border: 0, borderRadius: 999, padding: '11px 16px', fontWeight: 700, font: 'inherit', cursor: 'pointer', opacity: busy ? 0.55 : 1 }}>
              {busy ? 'Sending…' : 'Make'}
            </button>
          </form>

          <section style={{ minWidth: 0 }}>
            {!job && <div style={{ border: '1px solid #222', borderRadius: 12, padding: '28px 20px', color: '#8d8d8d', fontSize: 13, lineHeight: 1.5 }}>The finished cuts play here. They are also saved in the Library, with the character and the storyline on the item.</div>}

            {job && (
              <div style={{ border: '1px solid #222', borderRadius: 12, padding: 16, background: '#0e0e0e' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <div style={{ fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.title}</div>
                  <span style={{ fontSize: 11, color: '#8d8d8d', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{job.status}</span>
                  <button type="button" onClick={remove} style={{ ...ghost, color: '#888' }}>Remove</button>
                </div>

                {running && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#cfcfcf', marginBottom: 6 }}>
                      <span>{shotLine || job.stage || 'Working'}</span>
                      <span>{pct}%</span>
                    </div>
                    <div style={{ height: 3, background: '#222', borderRadius: 2 }}><div style={{ width: `${Math.max(pct, 4)}%`, height: 3, background: '#f4f4f4', borderRadius: 2 }} /></div>
                  </div>
                )}
                {job.error && <div style={{ color: '#f0a8a8', fontSize: 12, marginTop: 12, lineHeight: 1.4 }}>{job.error}</div>}

                {active && (
                  <video key={active.url} src={active.url} controls playsInline style={{ width: '100%', maxHeight: '62vh', marginTop: 14, background: '#000', borderRadius: 10 }} />
                )}
                {videos.length > 1 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {videos.map((f) => (
                      <button type="button" key={f.kind} onClick={() => setPick(f.kind)} style={{ ...ghost, background: active?.kind === f.kind ? '#f4f4f4' : '#161616', color: active?.kind === f.kind ? '#111' : '#ddd' }}>{f.label}</button>
                    ))}
                  </div>
                )}

                {!!job.files?.length && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 14, fontSize: 12 }}>
                    {job.files.map((f) => <a key={f.name} href={f.url + '?download=1'} style={{ color: '#d8d8d8' }}>{f.label}</a>)}
                    {onOpenLibrary && <button type="button" onClick={onOpenLibrary} style={{ ...ghost, padding: 0, border: 0, background: 'transparent', color: '#8d8d8d' }}>In the Library</button>}
                  </div>
                )}

                {contact && <img src={contact.url} alt="QC contact sheet" style={{ marginTop: 14, width: '100%', borderRadius: 10, border: '1px solid #222', display: 'block' }} />}
                {shotlist && <pre style={{ marginTop: 14, whiteSpace: 'pre-wrap', font: 'inherit', fontSize: 12, color: '#bdbdbd', lineHeight: 1.45, maxHeight: 220, overflow: 'auto' }}>{shotlist}</pre>}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
                  <span style={{ fontSize: 12, color: '#8d8d8d' }}>Redo shot</span>
                  <input value={redoN} onChange={(e) => setRedoN(e.target.value.replace(/[^\d]/g, '').slice(0, 2))} inputMode="numeric" style={{ ...field, width: 56, textAlign: 'center' }} />
                  <button type="button" onClick={redo} disabled={running} style={{ ...ghost, opacity: running ? 0.5 : 1 }}>Redo</button>
                </div>
                {redoNote && <div style={{ color: '#8d8d8d', fontSize: 12, marginTop: 8 }}>{redoNote}</div>}
              </div>
            )}

            {!!recent.length && (
              <div style={{ marginTop: 18 }}>
                <div style={{ ...label, marginTop: 0 }}>RECENT</div>
                {recent.map((j) => (
                  <button type="button" key={j.id} onClick={() => openJob(j.id)} style={{ ...ghost, display: 'flex', width: '100%', justifyContent: 'space-between', marginBottom: 6, background: job?.id === j.id ? '#1a1a1a' : '#121212' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</span>
                    <span style={{ color: '#777', marginLeft: 8 }}>{j.status}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
