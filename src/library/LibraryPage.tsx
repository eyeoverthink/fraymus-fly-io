import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch, errorText } from '../lib/api'
import { toast } from '../components/Toasts'

type Item = {
  id: string; type: string; title: string; agentId?: string; userId: string; owner: string; tags: string[]; favorite: boolean
  createdAt: number; mime?: string; preview?: string; size: number; meta: any; fileUrl: string; thumbUrl: string | null; mediaUrl: string | null; hasFile: boolean
}
type List = { items: Item[]; total: number; facets: { types: Record<string, number>; agents: Record<string, number> } }

const TYPES: [string, string][] = [['image', 'Images'], ['media', 'Video/audio'], ['chat', 'Chats'], ['evolve', 'Evolve jobs'], ['fossil', 'Fossils'], ['pattern', 'Patterns'],
  ['memory', 'Memories'], ['akashic', 'Akashic'], ['canvas', 'Canvas'], ['buyer', 'Buyer outputs']]
const ICON: Record<string, string> = { image: '🖼', media: '🎞', chat: '💬', evolve: '🧬', fossil: '🦴', pattern: '📐', memory: '🧠', akashic: '🕸', canvas: '🧩', buyer: '🛍' }
const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`)
const btn = { fontSize: 12, background: '#1a1a1a', color: '#e5e5e5', border: '1px solid #333', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' } as const
const input = { background: '#111', color: '#e5e5e5', border: '1px solid #333', borderRadius: 6, padding: '5px 8px', fontSize: 12 } as const
const get = async (url: string) => { const r = await apiFetch(url); if (!r.ok) throw new Error(await errorText(r)); return r.json() }

function Thumb({ it, big }: { it: Item; big?: boolean }) {
  const h = big ? 'auto' : 150
  const style = { width: '100%', height: h, maxHeight: big ? '70vh' : 150, objectFit: big ? 'contain' : 'cover', background: '#161616', borderRadius: 8, display: 'block' } as const
  if (it.mime?.startsWith('image/')) return <img src={big ? it.mediaUrl || it.fileUrl : it.thumbUrl || it.fileUrl} loading="lazy" style={style} onError={(e) => { if (it.mediaUrl && (e.target as HTMLImageElement).src !== location.origin + it.mediaUrl) (e.target as HTMLImageElement).src = it.mediaUrl }} />
  if (it.mime?.startsWith('video/')) return <video src={it.mediaUrl || it.fileUrl} controls={big} muted style={style} />
  if (it.mime?.startsWith('audio/')) return <div style={{ ...style, height: big ? 80 : 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><audio src={it.mediaUrl || it.fileUrl} controls style={{ width: '90%' }} /></div>
  return <div style={{ ...style, height: big ? 'auto' : 150, padding: 10, fontSize: 11, color: '#999', overflow: 'hidden', whiteSpace: 'pre-wrap', boxSizing: 'border-box' }}><span style={{ fontSize: 22 }}>{ICON[it.type]}</span><br />{it.preview}</div>
}

export default function LibraryPage() {
  const [q, setQ] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [agent, setAgent] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [fav, setFav] = useState(false)
  const [owner, setOwner] = useState('all')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [data, setData] = useState<List | null>(null)
  const [limit, setLimit] = useState(60)
  const [stats, setStats] = useState<any>(null)
  const [open, setOpen] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const params = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set('q', q.trim())
    if (types.length) p.set('type', types.join(','))
    if (agent) p.set('agent', agent)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (fav) p.set('favorite', '1')
    if (owner !== 'all') p.set('owner', owner)
    return p
  }, [q, types, agent, from, to, fav, owner])

  const load = useCallback(() => {
    setBusy(true)
    get(`/api/library?${params}&limit=${limit}`).then(setData).catch((e) => toast('error', e.message)).finally(() => setBusy(false))
  }, [params, limit])
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t) }, [load])
  useEffect(() => { get('/api/library/stats').then(setStats).catch(() => {}) }, [data?.total])

  const patch = async (it: Item, body: any) => {
    const r = await apiFetch(`/api/library/items/${it.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) return toast('error', await errorText(r))
    const n = await r.json()
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === it.id ? n : x)) })
    if (open?.id === it.id) setOpen({ ...open, ...n })
  }
  const remove = async (it: Item) => {
    if (!confirm(`Delete "${it.title}" from the Library?${it.mediaUrl ? '\nThe file itself will be deleted from the server.' : ''}\nThis cannot be undone.`)) return
    const r = await apiFetch(`/api/library/items/${it.id}`, { method: 'DELETE' })
    if (!r.ok) return toast('error', await errorText(r))
    setOpen(null); load()
  }
  const editTags = (it: Item) => {
    const s = prompt('Tags (comma separated)', it.tags.join(', '))
    if (s !== null) patch(it, { tags: s.split(',').map((t) => t.trim()).filter(Boolean) })
  }
  const openItem = (it: Item) => get(`/api/library/items/${it.id}`).then(setOpen).catch((e) => toast('error', e.message))
  const exportZip = async () => {
    const est = await get(`/api/library/export/estimate?${params}`).catch((e) => { toast('error', e.message); return null })
    if (!est) return
    if (!est.ok) return toast('error', `Export would be ${fmtBytes(est.bytes)} (limit ${fmtBytes(est.maxBytes)}). Narrow the filters.`)
    if (!confirm(`Download ${est.items} item(s) as a zip (~${fmtBytes(est.bytes)})?`)) return
    const a = document.createElement('a'); a.href = `/api/library/export?${params}`; a.click()
  }
  const toggleType = (t: string) => setTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))
  const vol = stats?.volume

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', height: '100%', minHeight: 0, color: '#e5e5e5', fontSize: 13 }}>
      <aside style={{ borderRight: '1px solid #222', padding: 12, overflow: 'auto' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Library</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything…" style={{ ...input, width: '100%', boxSizing: 'border-box', marginBottom: 10 }} />
        <div style={{ color: '#777', fontSize: 11, margin: '6px 0' }}>TYPE</div>
        {TYPES.map(([t, label]) => (
          <label key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0', cursor: 'pointer', color: data?.facets.types[t] ? '#e5e5e5' : '#555' }}>
            <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} /> {ICON[t]} {label} <span style={{ marginLeft: 'auto', color: '#666' }}>{data?.facets.types[t] || ''}</span>
          </label>
        ))}
        <div style={{ color: '#777', fontSize: 11, margin: '12px 0 4px' }}>AGENT</div>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} style={{ ...input, width: '100%' }}>
          <option value="">All agents</option>
          {Object.entries(data?.facets.agents || {}).map(([a, n]) => <option key={a} value={a}>{a} ({n})</option>)}
        </select>
        <div style={{ color: '#777', fontSize: 11, margin: '12px 0 4px' }}>DATE</div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...input, width: '100%', boxSizing: 'border-box', marginBottom: 4 }} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
        <label style={{ display: 'flex', gap: 6, marginTop: 12, cursor: 'pointer' }}><input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} /> ★ Favorites only</label>
        {stats?.owner && (<>
          <div style={{ color: '#777', fontSize: 11, margin: '12px 0 4px' }}>CREATED BY</div>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} style={{ ...input, width: '100%' }}>
            <option value="all">Everyone</option><option value="mine">Me</option><option value="buyers">Buyers</option><option value="users">Other users</option><option value="visitors">Visitors (30-day)</option>
          </select>
        </>)}
        <button style={{ ...btn, marginTop: 12, width: '100%' }} onClick={() => { setQ(''); setTypes([]); setAgent(''); setFrom(''); setTo(''); setFav(false); setOwner('all') }}>Clear filters</button>
        {stats && (
          <div style={{ marginTop: 16, fontSize: 11, color: '#888', lineHeight: 1.6 }}>
            {stats.items} items · {fmtBytes(stats.bytes)}
            {vol && <div>Volume: {fmtBytes(vol.usedBytes)} / {fmtBytes(vol.totalBytes)} ({vol.usedPct}%)
              <div style={{ height: 4, background: '#222', borderRadius: 2, marginTop: 3 }}><div style={{ width: `${Math.min(vol.usedPct, 100)}%`, height: 4, borderRadius: 2, background: vol.usedPct > 80 ? '#ef4444' : '#22c55e' }} /></div></div>}
          </div>
        )}
      </aside>

      <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid #222' }}>
          <span style={{ color: '#888' }}>{busy ? 'Loading…' : `${data?.total ?? 0} item(s)`}</span>
          <span style={{ flex: 1 }} />
          <button style={{ ...btn, background: view === 'grid' ? '#333' : '#1a1a1a' }} onClick={() => setView('grid')}>Grid</button>
          <button style={{ ...btn, background: view === 'list' ? '#333' : '#1a1a1a' }} onClick={() => setView('list')}>List</button>
          <button style={btn} onClick={load}>Refresh</button>
          <button style={{ ...btn, background: '#fff', color: '#000', fontWeight: 700 }} onClick={exportZip}>Export zip</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {data && !data.items.length && <div style={{ color: '#777', textAlign: 'center', marginTop: 60 }}>Nothing here yet. Everything you create (images, chats, evolve runs, memories, workflows) shows up automatically.</div>}
          {view === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
              {data?.items.map((it) => (
                <div key={it.id} style={{ background: '#111', border: '1px solid #222', borderRadius: 10, padding: 8, cursor: 'pointer' }} onClick={() => openItem(it)}>
                  <Thumb it={it} />
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.title}>{ICON[it.type]} {it.title}</div>
                    <span onClick={(e) => { e.stopPropagation(); patch(it, { favorite: !it.favorite }) }} style={{ color: it.favorite ? '#facc15' : '#555' }} title="Favorite">★</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#777' }}>{new Date(it.createdAt).toLocaleString()} · {it.agentId || it.owner}</div>
                </div>
              ))}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ color: '#777', textAlign: 'left' }}><th>★</th><th>Type</th><th>Title</th><th>Agent</th><th>Created</th><th>Size</th><th>Tags</th><th /></tr></thead>
              <tbody>{data?.items.map((it) => (
                <tr key={it.id} style={{ borderTop: '1px solid #1d1d1d' }}>
                  <td onClick={() => patch(it, { favorite: !it.favorite })} style={{ cursor: 'pointer', color: it.favorite ? '#facc15' : '#555' }}>★</td>
                  <td>{ICON[it.type]} {it.type}</td>
                  <td style={{ cursor: 'pointer', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '5px 0' }} onClick={() => openItem(it)}>{it.title}</td>
                  <td>{it.agentId || it.owner}</td><td>{new Date(it.createdAt).toLocaleString()}</td><td>{fmtBytes(it.size)}</td>
                  <td style={{ color: '#888' }}>{it.tags.join(', ')}</td>
                  <td><a href={`${it.fileUrl}?download=1`} style={{ color: '#93c5fd' }}>download</a></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {data && data.items.length < data.total && <div style={{ textAlign: 'center', margin: 16 }}><button style={btn} onClick={() => setLimit((l) => l + 60)}>Load more ({data.total - data.items.length} left)</button></div>}
        </div>
      </main>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#0f0f0f', border: '1px solid #333', borderRadius: 12, width: 'min(900px, 92vw)', maxHeight: '90vh', overflow: 'auto', padding: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <b style={{ flex: 1 }}>{ICON[open.type]} {open.title}</b>
              <span onClick={() => patch(open, { favorite: !open.favorite })} style={{ cursor: 'pointer', color: open.favorite ? '#facc15' : '#555', fontSize: 18 }}>★</span>
              <button style={btn} onClick={() => editTags(open)}>Tags</button>
              <a href={`${open.fileUrl}?download=1`} style={{ ...btn, textDecoration: 'none' }}>Download</a>
              <button style={{ ...btn, color: '#ef4444' }} onClick={() => remove(open)}>Delete</button>
              <button style={btn} onClick={() => setOpen(null)}>Close</button>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
              {new Date(open.createdAt).toLocaleString()} · {open.agentId || '-'} · {open.owner}{open.owner !== 'owner' ? ` (${open.userId})` : ''} · {fmtBytes(open.size)}
              {open.tags?.length ? ` · tags: ${open.tags.join(', ')}` : ''}{open.meta?.prompt ? <div>Prompt: {open.meta.prompt}</div> : null}
            </div>
            {open.hasFile && open.mime && !open.mime.includes('json') && <Thumb it={open} big />}
            {open.content && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#111', padding: 12, borderRadius: 8, margin: 0 }}>{open.content}</pre>}
          </div>
        </div>
      )}
    </div>
  )
}
