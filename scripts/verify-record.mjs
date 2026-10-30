#!/usr/bin/env node
// Verifies a copy of the episodic record (record.jsonl, SHA-256 chained). Exit 0 = intact, 1 = tampered/broken.
// Usage: node scripts/verify-record.mjs path/to/record.jsonl
//   or:  curl -H "Authorization: Bearer $TOKEN" .../api/memory/record/export | node scripts/verify-record.mjs -
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}
export function verify(text) {
  let prev = '0'.repeat(64), seq = 0, line = 0
  for (const raw of text.split('\n')) {
    line++
    if (!raw.trim()) continue
    let e
    try { e = JSON.parse(raw) } catch { return { ok: false, entries: seq, brokenAt: line, reason: 'unparseable line' } }
    if (e.seq !== seq + 1) return { ok: false, entries: seq, brokenAt: line, reason: `sequence gap (expected ${seq + 1}, got ${e.seq})` }
    if (e.prev !== prev) return { ok: false, entries: seq, brokenAt: line, reason: 'prev hash does not match the previous line' }
    const { hash, ...rest } = e
    if (createHash('sha256').update(rest.prev + canonical(rest)).digest('hex') !== hash) return { ok: false, entries: seq, brokenAt: line, reason: 'content does not match its hash (edited)' }
    prev = hash; seq = e.seq
  }
  return { ok: true, entries: seq, head: prev }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.argv[2]
  if (!f) { console.error('usage: node scripts/verify-record.mjs <record.jsonl | ->'); process.exit(2) }
  const r = verify(readFileSync(f === '-' ? 0 : f, 'utf8'))
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}
