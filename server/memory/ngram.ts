// Offline lexical ranker: 1024-bit character n-gram fold (16 × uint64) plus a full-text equality boost.
// This is a hashed character approximation, not semantic search, and it does not use Java string hashing.
// Memory search calls it only when MEMORY_NGRAM is explicitly on (see semantic.ts).
import { memoryNgramEnabled } from '../lib/flags'

export const HV_WORDS = 16
export const HV_BITS = HV_WORDS * 64
export const NGRAM_SCAN_LIMIT = 400
export const DEFAULT_EXACT_BOOST = 0.2

const MASK = (1n << 64n) - 1n
const GOLDEN = 0x9E3779B97F4A7C15n
const MIX1 = 0xBF58476D1CE4E5B9n
const MIX2 = 0x94D049BB133111EBn

const u64 = (x: bigint) => x & MASK
const rotl = (x: bigint, r: number) => {
  const v = u64(x)
  const s = BigInt(r)
  return u64((v << s) | (v >> (64n - s)))
}

export function normalizeText(text: unknown): string {
  if (typeof text === 'number' || typeof text === 'boolean') return String(text).toLowerCase()
  if (typeof text !== 'string') return ''
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function popcount64(x: bigint): number {
  let v = u64(x)
  let n = 0
  while (v) { v &= v - 1n; n++ }
  return n
}

/** Deterministic 1024-bit fold. The same text always yields the same bits. An empty string is the zero vector. */
export function foldNgrams(text: unknown): BigUint64Array {
  const hv = new BigUint64Array(HV_WORDS)
  const normalized = normalizeText(text)
  if (!normalized) return hv
  const accum = new Int32Array(HV_BITS)
  for (let i = 0; i < normalized.length; i++) {
    let seed = GOLDEN
    for (let k = 0; k < 3 && i + k < normalized.length; k++) {
      seed = u64(seed ^ (BigInt(normalized.charCodeAt(i + k)) << BigInt(k * 16)))
      seed = rotl(seed * MIX1, 31)
    }
    for (let w = 0; w < HV_WORDS; w++) {
      seed = u64(seed ^ (seed >> 30n))
      seed = u64(seed * MIX1)
      seed = u64(seed ^ (seed >> 27n))
      seed = u64(seed * MIX2)
      const word = u64(seed ^ (seed >> 31n))
      const base = w * 64
      const lo = Number(word & 0xffffffffn)
      const hi = Number((word >> 32n) & 0xffffffffn)
      for (let b = 0; b < 32; b++) {
        accum[base + b] += (lo >>> b) & 1 ? 1 : -1
        accum[base + 32 + b] += (hi >>> b) & 1 ? 1 : -1
      }
    }
  }
  for (let w = 0; w < HV_WORDS; w++) {
    let word = 0n
    const base = w * 64
    for (let b = 0; b < 64; b++) if (accum[base + b] >= 0) word |= 1n << BigInt(b)
    hv[w] = word
  }
  return hv
}

/** 1 = identical bits, 0 = every bit differs. */
export function hammingSimilarity(a: BigUint64Array, b: BigUint64Array): number {
  if (a.length !== HV_WORDS || b.length !== HV_WORDS) return 0
  let diff = 0
  for (let i = 0; i < HV_WORDS; i++) diff += popcount64(a[i] ^ b[i])
  const sim = 1 - diff / HV_BITS
  return Number.isFinite(sim) ? Math.min(1, Math.max(0, sim)) : 0
}

export type RankDoc = { id: string | number; text: unknown }
export type RankHit = { id: string | number; score: number; similarity: number; exact: boolean }

function cmpId(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

function takeLimit(limit: number | undefined, n: number): number {
  if (limit == null) return n
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return n
  if (limit <= 0) return 0
  return Math.min(n, Math.floor(limit))
}

/**
 * Rank docs by n-gram similarity, then by id. An empty or blank query returns nothing
 * (the zero vector would otherwise look like a perfect match). Full-string equality,
 * after the same normalization, adds exactBoost. Ties ignore the text and use id.
 */
export function rankNgrams(query: unknown, docs: readonly RankDoc[] | null | undefined, opts: { limit?: number; exactBoost?: number } = {}): RankHit[] {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery || !Array.isArray(docs)) return []
  const boost = typeof opts.exactBoost === 'number' && Number.isFinite(opts.exactBoost) ? opts.exactBoost : DEFAULT_EXACT_BOOST
  const qv = foldNgrams(normalizedQuery)
  const hits: RankHit[] = []
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue
    const id = (doc as RankDoc).id
    if (typeof id === 'number') { if (!Number.isFinite(id)) continue }
    else if (typeof id !== 'string' || !id) continue
    const text = normalizeText((doc as RankDoc).text)
    const similarity = hammingSimilarity(qv, foldNgrams(text))
    const exact = text === normalizedQuery
    hits.push({ id, score: similarity + (exact ? boost : 0), similarity, exact })
  }
  hits.sort((a, b) => (b.score === a.score ? cmpId(a.id, b.id) : b.score - a.score))
  return hits.slice(0, takeLimit(opts.limit, hits.length))
}

/**
 * Numeric mix for callers that already have a base score. Disabled (the default) returns base unchanged.
 * Retrieve itself does not call this: when the env flag is on it adds an RRF voter instead, so the
 * n-gram channel stays on the same scale as FTS and vector search.
 */
export function blendRankScore(base: number, extra: number, enabled: boolean, weight = 0.15): number {
  if (!enabled) return base
  if (!Number.isFinite(base)) return 0
  const n = Number.isFinite(extra) ? extra : 0
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0
  return base * (1 - w) + n * w
}

export function ngramRankEnabled(): boolean {
  return memoryNgramEnabled()
}

export function ngramStatus() {
  return {
    enabled: ngramRankEnabled(),
    candidate: true as const,
    kind: 'hashed-character-ngram' as const,
    note: 'Lexical approximation. Not semantic search. Used only when MEMORY_NGRAM is on, 1, or true.'
  }
}
