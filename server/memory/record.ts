// Episodic log: append-only DATA_DIR/record.jsonl. Every line is SHA-256 chained to the one before it (DOC-SEAL chain):
//   hash = sha256(prev + canonical JSON of the entry without its hash)
// so editing, deleting or reordering any past line breaks verification from that line on.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const GENESIS = '0'.repeat(64)
export type RecordEntry = { seq: number; ts: number; prev: string; kind: string; userId?: string; agentId?: string; threadId?: string; data: any; hash: string }

const recordPath = () => process.env.RECORD_FILE || `${process.env.DATA_DIR || './data'}/record.jsonl`
const MAX_FIELD = 4000

// Stable key order so the hash does not depend on how an object was built
export function canonical(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}
export const entryHash = (e: Omit<RecordEntry, 'hash'>) => createHash('sha256').update(e.prev + canonical(e)).digest('hex')

const clipDeep = (v: any, depth = 0): any => {
  if (typeof v === 'string') return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + '…[clipped]' : v
  if (!v || typeof v !== 'object' || depth > 4) return v
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipDeep(x, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, depth + 1)]))
}

function lastLine(path: string): string | null {
  if (!existsSync(path)) return null
  const size = statSync(path).size
  if (!size) return null
  const fd = openSync(path, 'r')
  try {
    let pos = size, tail = ''
    while (pos > 0) {
      const n = Math.min(65536, pos)
      pos -= n
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, pos)
      tail = buf.toString('utf8') + tail
      const lines = tail.split('\n').filter((l) => l.trim())
      if (lines.length > 1 || pos === 0) return lines[lines.length - 1] || null
    }
    return null
  } finally { closeSync(fd) }
}

let head: { seq: number; hash: string } | null = null
function loadHead() {
  if (head) return head
  const l = lastLine(recordPath())
  if (!l) return (head = { seq: 0, hash: GENESIS })
  try { const e = JSON.parse(l); return (head = { seq: e.seq, hash: e.hash }) } catch { throw new Error('record.jsonl last line is corrupt; run the chain verifier') }
}

export function appendRecord(kind: string, data: any, meta: { userId?: string; agentId?: string; threadId?: string } = {}): RecordEntry | null {
  if (process.env.RECORD === 'off') return null
  try {
    const h = loadHead()
    // Anonymous visitors: the permanent chain only keeps a digest, so their content can still be purged by the retention limit
    const body = meta.userId?.startsWith('visitor:') ? { sha256: createHash('sha256').update(canonical(data)).digest('hex'), chars: canonical(data).length } : clipDeep(data)
    const base = { seq: h.seq + 1, ts: Date.now(), prev: h.hash, kind, userId: meta.userId, agentId: meta.agentId, threadId: meta.threadId || undefined, data: body }
    const e: RecordEntry = { ...base, hash: entryHash(base) }
    const p = recordPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(e) + '\n')
    head = { seq: e.seq, hash: e.hash }
    return e
  } catch (err: any) {
    console.error('[record] append failed:', err.message)
    return null
  }
}

export type VerifyResult = { ok: boolean; entries: number; head: string; brokenAt?: number; reason?: string }

// Verifies a chain given as JSONL text (works on the live file or any copy)
export function verifyText(text: string): VerifyResult {
  let prev = GENESIS, seq = 0, line = 0
  for (const raw of text.split('\n')) {
    line++
    if (!raw.trim()) continue
    let e: RecordEntry
    try { e = JSON.parse(raw) } catch { return { ok: false, entries: seq, head: prev, brokenAt: line, reason: 'unparseable line' } }
    if (e.seq !== seq + 1) return { ok: false, entries: seq, head: prev, brokenAt: line, reason: `sequence gap (expected ${seq + 1}, got ${e.seq})` }
    if (e.prev !== prev) return { ok: false, entries: seq, head: prev, brokenAt: line, reason: 'prev hash does not match the previous line' }
    const { hash, ...rest } = e
    if (entryHash(rest) !== hash) return { ok: false, entries: seq, head: prev, brokenAt: line, reason: 'content does not match its hash (edited)' }
    prev = hash; seq = e.seq
  }
  return { ok: true, entries: seq, head: prev }
}
export const verifyRecord = (path = recordPath()) => (existsSync(path) ? verifyText(readFileSync(path, 'utf8')) : { ok: true, entries: 0, head: GENESIS })

export function tailRecord(userId: string, limit = 50, kind?: string): RecordEntry[] {
  const p = recordPath()
  if (!existsSync(p)) return []
  const size = statSync(p).size
  const fd = openSync(p, 'r')
  const n = Math.min(size, 4 * 1024 * 1024)
  const buf = Buffer.alloc(n)
  try { readSync(fd, buf, 0, n, size - n) } finally { closeSync(fd) }
  const out: RecordEntry[] = []
  const lines = buf.toString('utf8').split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { const e = JSON.parse(lines[i]); if (e.userId === userId && (!kind || e.kind === kind)) out.push(e) } catch {}
  }
  return out
}
