// Self-contained test for the Library: auto-capture of everything created in the app, visibility
// (owner / buyer / visitor), search, favorite/tag, delete, backfill, export zip, record events.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { verify } from './verify-record.mjs'

const TOKEN = randomBytes(24).toString('hex')
let failures = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// ---- fake LLM: "draw X" -> generate_image, "remember X" -> memory_save, evolve architect/critic ----
function fakeChat(body) {
  const msgs = body.messages, sys = msgs[0]?.content || '', last = msgs[msgs.length - 1]
  const tools = (body.tools || []).map((t) => t.function.name)
  const say = (content) => ({ choices: [{ message: { role: 'assistant', content } }] })
  const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  if (sys.startsWith('You are ARCHITECT')) return say('NAME: mul\nPATTERN: multiply two numbers\n```js file=solution.mjs\nexport function mul(a, b) { return a * b }\n```\n```js file=test.mjs\nimport assert from "node:assert/strict"\nimport { mul } from "./solution.mjs"\nassert.equal(mul(2, 3), 6)\n```')
  if (sys.startsWith('You are CRITIC')) return say('{"blocking": false, "issues": []}')
  if (last.role === 'tool') return say('Here you go.')
  const d = last.content.match(/draw (.+)/i)
  if (d && tools.includes('generate_image')) return call('generate_image', { prompt: d[1] })
  const m = last.content.match(/remember (?:that )?(.+)/i)
  if (m && tools.includes('memory_save')) return call('memory_save', { text: m[1] })
  return say('Hello from the fake model about ' + last.content.slice(0, 40))
}
const llm = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}')
    const out = req.url.endsWith('/embeddings') ? { data: [].concat(body.input).map((t, i) => ({ index: i, embedding: new Array(16).fill(0).map((_, k) => (String(t).length * (k + 1)) % 7) })) } : fakeChat(body)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
const LLM = `http://127.0.0.1:${llm.address().port}/v1`

async function boot(dataDir) {
  const port = String(4800 + Math.floor(Math.random() * 400))
  const env = { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'openai', OPENAI_BASE_URL: LLM, OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'fake',
    EMBED_BASE_URL: LLM, EMBED_API_KEY: 'fake', SCHEDULER: 'off', NODE_ENV: 'test', WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: TOKEN, GROQ_API_KEY: '', CLERK_SECRET_KEY: '', SUPABASE_URL: '',
    FREE_CREDITS: '', LIBRARY_SYNC_MS: '600000', REPLICATE_API_TOKEN: '', FAL_KEY: '', HF_TOKEN: '' }
  const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore', detached: true })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await sleep(400) }
  return { base, dataDir, stop: () => new Promise((r) => { p.on('exit', () => setTimeout(r, 300)); try { process.kill(-p.pid) } catch { p.kill() } }) }
}
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const api = async (s, path, opts = {}) => { const r = await fetch(s.base + path, { headers: opts.body ? H : { Authorization: H.Authorization }, ...opts }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) } }
async function agentSay(s, message) {
  const r = await api(s, '/api/agent/runs', { method: 'POST', body: JSON.stringify({ agentId: 'concierge', message }) })
  const tid = r.body?.threadId
  for (let i = 0; i < 80; i++) {
    const t = (await api(s, `/api/agent/threads/${tid}`)).body
    if (t?.run && !['running', 'queued'].includes(t.run.status)) return { tid, t }
    await sleep(250)
  }
  return { tid }
}
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = new Map()
  for (let i = 0; i < n; i++) {
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8')
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const data = buf.subarray(ds, ds + size)
    if ((crc32(data) >>> 0) !== crc) throw new Error('crc mismatch ' + name)
    out.set(name, data); p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

// ---- pre-existing data on the volume (backfill) ----
const dataDir = mkdtempSync(join(tmpdir(), 'lib-test-'))
mkdirSync(join(dataDir, 'outputs'), { recursive: true })
const oldFile = join(dataDir, 'outputs', '1000-legacy.png'); writeFileSync(oldFile, PNG)
const hourAgo = (Date.now() - 3600_000) / 1000; utimesSync(oldFile, hourAgo, hourAgo)

const s = await boot(dataDir)
try {
  // --- auth gate
  for (const p of ['/api/library', '/api/library/stats', '/api/library/export', '/api/library/items/x/file']) ok((await fetch(s.base + p)).status === 401, `auth: ${p} is 401 without the token`)
  ok((await fetch(s.base + '/buyer/library')).status === 401, 'auth: /buyer/library is 401 without a buyer session')

  // --- backfill
  let lib = (await api(s, '/api/library')).body
  const legacy = lib.items.find((i) => i.sourceId === 'file:1000-legacy.png')
  ok(legacy && legacy.type === 'image' && legacy.owner === 'owner' && legacy.tags.includes('unattributed'), 'backfill: existing /outputs file appears as an owner image')

  // --- concierge image chat
  const img = await agentSay(s, 'draw a neon lighthouse at dusk')
  ok(img.t?.messages?.some((m) => m.role === 'tool' && m.name === 'generate_image'), 'chat: concierge called generate_image')
  lib = (await api(s, '/api/library?type=image')).body
  const gen = lib.items.find((i) => i.meta?.threadId === img.tid)
  ok(gen && gen.agentId === 'concierge' && /lighthouse/.test(gen.title) && gen.mediaUrl?.startsWith('/outputs/'), 'image: generated image saved with prompt, agent and thread')
  const chats = (await api(s, '/api/library?type=chat')).body
  ok(chats.items.some((i) => i.sourceId === `thread:${img.tid}`), 'chat: thread saved as a chat item')
  const f = await fetch(s.base + gen.fileUrl, { headers: { Authorization: H.Authorization } })
  ok(f.status === 200 && f.headers.get('content-type') === 'image/png' && (await f.arrayBuffer()).byteLength > 0, 'image: file served from library')
  const th = await fetch(s.base + gen.thumbUrl, { headers: { Authorization: H.Authorization } })
  ok(th.status === 200 && /image\//.test(th.headers.get('content-type')), 'image: thumbnail served')

  // --- memory, akashic
  await agentSay(s, 'remember that the launch codename is kestrel-88')
  lib = (await api(s, '/api/library?type=memory&q=kestrel')).body
  ok(lib.items.length >= 1 && /kestrel-88/.test(lib.items[0].title), 'memory: saved memory searchable in library')
  await api(s, '/api/akashic/entities', { method: 'POST', body: JSON.stringify({ name: 'Project Kite', type: 'project', summary: 'drone mapping venture' }) })
  await api(s, '/api/akashic/decisions', { method: 'POST', body: JSON.stringify({ title: 'Use Fly volumes', decision: 'keep files on /data', rationale: 'simple' }) })
  lib = (await api(s, '/api/library?type=akashic')).body
  ok(lib.items.some((i) => /Project Kite/.test(i.title)) && lib.items.some((i) => /Use Fly volumes/.test(i.title)), 'akashic: entity and decision saved')

  // --- evolve -> evolve job, fossil, pattern
  const ev = await api(s, '/api/evolve?wait=1', { method: 'POST', body: JSON.stringify({ task: 'export function mul(a, b) that multiplies', maxRounds: 2 }) })
  ok(ev.body?.status === 'passed', `evolve: run passed (${ev.body?.status})`)
  lib = (await api(s, '/api/library?type=evolve,fossil,pattern')).body
  ok(['evolve', 'fossil', 'pattern'].every((t) => lib.items.some((i) => i.type === t)), 'evolve: job, fossil and proven pattern all saved')
  const fos = lib.items.find((i) => i.type === 'fossil')
  const fd = (await api(s, `/api/library/items/${fos.id}`)).body
  ok(fd.content.includes('a * b') && fd.data?.files?.['solution.mjs'], 'fossil: snapshot includes the verified code')

  // --- canvas endpoint saves output
  const cf = await fetch(s.base + '/api/flux', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'canvas sunflower field' }) })
  const libId = cf.headers.get('x-library-item')
  ok(cf.status === 200 && libId, 'canvas: /api/flux output registered (X-Library-Item)')
  const ci = (await api(s, `/api/library/items/${libId}`)).body
  ok(ci?.agentId === 'canvas' && ci.tags.includes('flux'), 'canvas: item tagged canvas/flux')

  // --- buyer outputs (seed a buyer session + run in the workflow store)
  const nd = new DatabaseSync(join(dataDir, 'nodular.db'))
  const sha = (t) => createHash('sha256').update(t).digest('hex')
  const tokA = 'bs_' + randomBytes(16).toString('hex'), tokB = 'bs_' + randomBytes(16).toString('hex')
  for (const [u, t, n] of [['buyer_aaa', tokA, 'a'], ['buyer_bbb', tokB, 'b']]) {
    nd.prepare('insert into users(id,email,credits) values(?,?,1)').run(u, `${n}@example.com`)
    nd.prepare('insert into buyer_sessions(token_hash,user_id,expires_at) values(?,?,?)').run(sha(t), u, Date.now() + 3600_000)
    writeFileSync(join(dataDir, 'outputs', `buyer-${n}.png`), PNG)
    nd.prepare("insert into workflow_runs(workflow_id,user_id,status,input_prompt,results,final_image_url,duration_ms) values('buyer-enhance',?,'success',?,'{}',?,1200)").run(u, `product shot ${n}`, `/outputs/buyer-${n}.png`)
  }
  nd.close()
  const bl = await fetch(s.base + '/buyer/library', { headers: { Authorization: 'Bearer ' + tokA } }).then((r) => r.json())
  ok(bl.items?.length === 1 && bl.items[0].imageUrl === '/outputs/buyer-a.png', 'buyer: sees only their own output')
  lib = (await api(s, '/api/library?owner=buyers')).body
  ok(lib.items.filter((i) => i.type === 'buyer').length === 2, 'buyer: owner sees all buyer outputs keyed to each buyer')
  ok(new Set(lib.items.map((i) => i.userId)).size === 2, 'buyer: items keyed by buyer id')

  // --- visitor chat follows visitor deletion
  const vr = await fetch(s.base + '/public/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi there walrus' }) })
  const cookie = (vr.headers.get('set-cookie') || '').match(/fv=[^;]*/)?.[0]
  lib = (await api(s, '/api/library?owner=visitors')).body
  ok(lib.items.some((i) => i.owner === 'visitor' && i.type === 'chat'), 'visitor: chat saved under the visitor')
  await fetch(s.base + '/public/memory', { method: 'DELETE', headers: { cookie } })
  lib = (await api(s, '/api/library?owner=visitors')).body
  ok(lib.total === 0, 'visitor: forget-me removes their library items')

  // --- search, filters, favorite/tag, date
  ok((await api(s, '/api/library?q=lighthouse')).body.items.some((i) => i.id === gen.id), 'search: full-text finds the image by prompt')
  ok((await api(s, '/api/library?q=zzznomatch')).body.total === 0, 'search: no false positives')
  ok((await api(s, '/api/library?agent=concierge')).body.items.every((i) => i.agentId === 'concierge'), 'filter: by agent')
  ok((await api(s, '/api/library?from=2000-01-01&to=2000-01-02')).body.total === 0, 'filter: by date')
  const pt = await api(s, `/api/library/items/${gen.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: true, tags: ['hero', 'v1'] }) })
  ok(pt.body?.favorite && pt.body.tags.includes('hero'), 'patch: favorite + tags')
  ok((await api(s, '/api/library?favorite=1')).body.items.map((i) => i.id).join() === gen.id, 'filter: favorites')
  ok((await api(s, '/api/library?q=hero')).body.items.some((i) => i.id === gen.id), 'search: finds by user tag')
  const st = (await api(s, '/api/library/stats')).body
  ok(st.items > 5 && st.volume?.totalBytes > 0, 'stats: item count + volume usage')

  // --- export
  const est = (await api(s, '/api/library/export/estimate?type=image')).body
  ok(est.ok && est.items >= 3, `export: estimate (${est.items} items, ${est.bytes} bytes)`)
  const zr = await fetch(s.base + '/api/library/export', { headers: { Authorization: H.Authorization } })
  const zip = Buffer.from(await zr.arrayBuffer())
  const files = readZip(zip)
  const man = JSON.parse(files.get('manifest.json'))
  ok(zr.status === 200 && zr.headers.get('content-type') === 'application/zip' && man.items.length === st.items, `export: zip with manifest of all ${man.items.length} items`)
  ok([...files.keys()].some((n) => n.startsWith('image/') && n.endsWith('.png')) && [...files.keys()].some((n) => n.startsWith('fossil/') && n.endsWith('.md')), 'export: media + text snapshots inside')
  const zf = readZip(Buffer.from(await (await fetch(s.base + '/api/library/export?type=fossil', { headers: { Authorization: H.Authorization } })).arrayBuffer()))
  ok(JSON.parse(zf.get('manifest.json')).items.every((i) => i.type === 'fossil'), 'export: filtered export')

  // --- delete (snapshot survives source deletion; delete removes + tombstones)
  await api(s, `/api/agent/threads/${img.tid}`, { method: 'DELETE' })
  ok((await api(s, '/api/library?type=chat')).body.items.some((i) => i.sourceId === `thread:${img.tid}`), 'retention: chat stays in the library after the thread is deleted')
  const mediaPath = join(dataDir, gen.mediaUrl)
  ok((await api(s, `/api/library/items/${gen.id}`, { method: 'DELETE' })).status === 200 && !existsSync(mediaPath), 'delete: item and its file removed')
  await api(s, '/api/library/sync', { method: 'POST', body: '{}' })
  ok((await api(s, `/api/library/items/${gen.id}`)).status === 404, 'delete: not re-added by the next sync')

  // --- record events
  const exp = await fetch(s.base + '/api/memory/record/export', { headers: H }).then((r) => r.text())
  ok(verify(exp).ok, 'record: chain verifies')
  for (const k of ['library.backfill', 'library.add', 'library.update', 'library.delete', 'library.export']) ok(exp.includes(`"kind":"${k}"`), `record: ${k} logged`)
} finally { await s.stop(); llm.close(); try { rmSync(dataDir, { recursive: true, force: true }) } catch {} }
console.log(failures ? `\n${failures} library check(s) FAILED` : '\nAll library checks passed')
process.exit(failures ? 1 : 0)
