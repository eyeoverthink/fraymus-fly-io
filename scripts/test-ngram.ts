// Hashed n-gram candidate: ranker properties plus a labelled synthetic comparison with current memory search.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ngram-test-'))
process.env.DATA_DIR = dir
process.env.EMBED_BACKEND = 'off'
delete process.env.MEMORY_NGRAM
delete process.env.EMBED_BASE_URL
delete process.env.EMBED_API_KEY
delete process.env.OPENAI_BASE_URL
delete process.env.OPENAI_API_KEY

const ngram = await import('../server/memory/ngram.ts')
const semantic = await import('../server/memory/semantic.ts')

let failures = 0
let passes = 0
const ok = (c: unknown, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }

const { foldNgrams, hammingSimilarity, rankNgrams, blendRankScore, ngramRankEnabled, HV_WORDS } = ngram

ok(ngramRankEnabled() === false, 'MEMORY_NGRAM absent keeps the candidate off')
process.env.MEMORY_NGRAM = ''
ok(ngramRankEnabled() === false, 'MEMORY_NGRAM empty stays off')
process.env.MEMORY_NGRAM = 'off'
ok(ngramRankEnabled() === false, 'MEMORY_NGRAM=off stays off')
process.env.MEMORY_NGRAM = 'true'
ok(ngramRankEnabled() === true, 'MEMORY_NGRAM=true turns the candidate on')
delete process.env.MEMORY_NGRAM

const same = foldNgrams('Alpha  BETA')
const again = foldNgrams('alpha beta')
ok(same.length === HV_WORDS && same.every((w, i) => w === again[i]), 'fold: whitespace and case normalize, and the fold is deterministic')
ok(hammingSimilarity(same, again) === 1, 'fold: a text matches itself')
ok(foldNgrams('').every((w) => w === 0n) && foldNgrams('   ').every((w) => w === 0n) && foldNgrams(null).every((w) => w === 0n), 'fold: empty and null-ish text is the zero vector')

function javaHash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h, 31) + s.charCodeAt(i) | 0
  return h
}
ok(javaHash('Aa') === javaHash('BB'), 'fixture: Aa and BB share a Java hashCode')
ok(!foldNgrams('Aa').every((w, i) => w === foldNgrams('BB')[i]), 'fold: those two strings do not share an n-gram vector')

ok(rankNgrams('', [{ id: 1, text: 'alpha' }]).length === 0, 'rank: empty query returns nothing')
ok(rankNgrams('   ', [{ id: 1, text: 'alpha' }]).length === 0, 'rank: blank query returns nothing')
ok(rankNgrams(null, [{ id: 1, text: 'alpha' }]).length === 0, 'rank: null query returns nothing')
ok(rankNgrams('alpha', null).length === 0 && rankNgrams('alpha', undefined).length === 0, 'rank: null-ish docs return nothing')

const weird = rankNgrams('hello', [null, undefined, { text: 'hello' }, { id: null, text: 'hello' }, { id: Number.NaN, text: 'hello' }, { id: '', text: 'hello' }, { id: 2, text: null }, { id: 3, text: undefined }, 'nope', { id: 4, text: 'hello' }] as never)
ok(weird.map((h) => h.id).join() === '4,2,3' && weird[0].exact, `rank: bad entries are skipped, null text does not throw, and the exact row ranks first (${weird.map((h) => h.id).join()})`)

const ties = rankNgrams('alpha beta', [
  { id: 10, text: 'alpha beta' },
  { id: 2, text: 'alpha   beta' },
  { id: 3, text: 'ALPHA BETA' }
])
ok(ties.map((h) => h.id).join() === '2,3,10' && ties.every((h) => h.exact), 'rank: equal texts tie-break by id, independent of input order')
const once = JSON.stringify(rankNgrams('alpha beta', [{ id: 'b', text: 'alpha beta' }, { id: 'a', text: 'alpha beta' }]))
const twice = JSON.stringify(rankNgrams('alpha beta', [{ id: 'b', text: 'alpha beta' }, { id: 'a', text: 'alpha beta' }]))
ok(once === twice && JSON.parse(once).map((h: { id: string }) => h.id).join() === 'a,b', 'rank: repeated calls and string ids stay stable')

const reorder = rankNgrams('alpha beta gamma delta', [
  { id: 3, text: 'quartz xylophone mercury violin' },
  { id: 2, text: 'delta gamma beta alpha' },
  { id: 1, text: 'alpha beta gamma delta' }
])
ok(reorder.map((h) => h.id).join() === '1,2,3' && reorder[0].exact && !reorder[1].exact && reorder[0].score > reorder[1].score && reorder[1].score > reorder[2].score, 'rank: exact text beats a word reorder, which beats a missing match')

const missing = rankNgrams('alpha beta', [
  { id: 2, text: 'zzzz qqqq xxxx' },
  { id: 1, text: 'alpha beta stays here' }
])
ok(missing[0].id === 1 && missing[0].score > missing[1].score && !missing[0].exact, 'rank: a partial lexical match outranks an unrelated note')

const dupes = [
  { id: 1, text: 'same words' },
  { id: 1, text: 'same words' },
  { id: 4, text: 'same words' }
]
ok(rankNgrams('same words', dupes).length === 3, 'rank: duplicate rows are kept')
ok(rankNgrams('same words', dupes, { limit: 0 }).length === 0, 'rank: limit 0 returns nothing')
ok(rankNgrams('same words', dupes, { limit: -3 }).length === 0, 'rank: a negative limit returns nothing')
ok(rankNgrams('same words', dupes, { limit: 1 }).map((h) => h.id).join() === '1', 'rank: limit 1 keeps the lowest id')
ok(rankNgrams('same words', dupes, { limit: 1.9 }).length === 1, 'rank: a fractional limit floors')
ok(rankNgrams('same words', dupes, { limit: 50 }).length === 3, 'rank: a limit past the end returns every row')
ok(rankNgrams('same words', dupes, { exactBoost: 0 }).every((h) => h.exact && h.score === h.similarity), 'rank: exactBoost 0 leaves the approximate score')
ok(blendRankScore(0.4, 0.9, false) === 0.4, 'blend: disabled returns the base score')
ok(Math.abs(blendRankScore(0.4, 0.9, true, 0.25) - (0.4 * 0.75 + 0.9 * 0.25)) < 1e-12, 'blend: enabled mixes in the extra score')
ok(blendRankScore(Number.NaN, 1, true) === 0, 'blend: a non-finite base becomes 0 only when enabled')

type Doc = { id: number; text: string; topic: string }
const topics = [
  ['zebra', 'codename', 'vault'],
  ['quartz', 'lattice', 'photon'],
  ['otter', 'biscuit', 'ledger'],
  ['maple', 'syrup', 'invoice'],
  ['cobalt', 'thruster', 'gimbal'],
  ['linen', 'canvas', 'stitch'],
  ['amber', 'resin', 'fossil'],
  ['indigo', 'pigment', 'vellum']
]
const docs: Doc[] = []
for (const words of topics) {
  const [a, b, c] = words
  const topic = a
  const variants = [
    `The ${a} ${b} stays in the ${c}.`,
    `${c} ${b} ${a} remains on record.`,
    `Notes mention ${a}, then ${b}, then ${c}, with no other topic.`
  ]
  for (const text of variants) {
    const id = semantic.indexDoc({ userId: 'bench', scope: 'shared', kind: 'note', text })
    if (id) docs.push({ id, text, topic })
  }
}
const stopId = semantic.indexDoc({ userId: 'bench', scope: 'shared', kind: 'note', text: 'the and for' })
if (stopId) docs.push({ id: stopId, text: 'the and for', topic: 'stop' })
ok(docs.length === topics.length * 3 + 1 && docs.every((d) => d.id), `benchmark corpus indexed (${docs.length} docs)`)
await new Promise((r) => setTimeout(r, 1700))

type Group = 'keyword' | 'reorder' | 'exact' | 'prefix' | 'stopword'
type Query = { group: Group; query: string; relevant: number[] }
const queries: Query[] = []
for (const words of topics) {
  const [a, b, c] = words
  const related = docs.filter((d) => d.topic === a).map((d) => d.id)
  queries.push({ group: 'keyword', query: `${a} ${b}`, relevant: related })
  queries.push({ group: 'reorder', query: `${c} ${a} ${b}`, relevant: related })
  const exact = docs.find((d) => d.topic === a && d.text.startsWith('The '))!
  queries.push({ group: 'exact', query: exact.text, relevant: [exact.id] })
  queries.push({ group: 'prefix', query: a.slice(0, 4), relevant: related })
}
const stop = docs.find((d) => d.topic === 'stop')!
queries.push({ group: 'stopword', query: 'the and for', relevant: [stop.id] })

const K = 5
const repeats = 7
type Metrics = { recall: number; precision: number; medianMs: number }
function atK(ids: number[], relevant: number[]) {
  const top = ids.slice(0, K)
  const rel = new Set(relevant)
  const hits = top.filter((id) => rel.has(id)).length
  return { recall: relevant.length ? hits / relevant.length : 0, precision: hits / K }
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
async function measure(group: Group, run: (q: Query) => Promise<number[]> | number[]): Promise<Metrics> {
  const subset = queries.filter((q) => q.group === group)
  let recall = 0
  let precision = 0
  for (const q of subset) {
    const ids = await run(q)
    const m = atK(ids, q.relevant)
    recall += m.recall
    precision += m.precision
  }
  const samples: number[] = []
  for (let i = 0; i < repeats; i++) {
    const t = performance.now()
    for (const q of subset) await run(q)
    samples.push((performance.now() - t) / subset.length)
  }
  return { recall: recall / subset.length, precision: precision / subset.length, medianMs: median(samples) }
}

const ftsRun = async (q: Query) => (await semantic.retrieve('bench', null, q.query, { limit: K })).map((h) => h.id)
const ngramRun = (q: Query) => rankNgrams(q.query, docs, { limit: K }).map((h) => h.id as number)
const blendedRun = async (q: Query) => (await semantic.retrieve('bench', null, q.query, { limit: K })).map((h) => h.id)

const groups: Group[] = ['keyword', 'reorder', 'exact', 'prefix', 'stopword']
const report: Record<string, { fts: Metrics; ngram: Metrics; blended: Metrics }> = {}
for (const group of groups) {
  delete process.env.MEMORY_NGRAM
  const fts = await measure(group, ftsRun)
  const ngramMetrics = await measure(group, ngramRun)
  process.env.MEMORY_NGRAM = 'on'
  const blended = await measure(group, blendedRun)
  report[group] = { fts, ngram: ngramMetrics, blended }
}
delete process.env.MEMORY_NGRAM

const fmt = (m: Metrics) => `recall@${K}=${m.recall.toFixed(3)} precision@${K}=${m.precision.toFixed(3)} medianMs=${m.medianMs.toFixed(3)}`
console.log('\nBENCHMARK hashed-character-ngram candidate vs current memory search')
console.log(`corpus=${docs.length} labelledQueries=${queries.length} k=${K} embeddings=off`)
console.log('relevance is synthetic and lexical. precision@5 divides hits by 5. This is not a semantic score.')
for (const group of groups) {
  const row = report[group]
  console.log(`group=${group} n=${queries.filter((q) => q.group === group).length}`)
  console.log(`  current-fts  ${fmt(row.fts)}`)
  console.log(`  ngram        ${fmt(row.ngram)}`)
  console.log(`  fts+ngram    ${fmt(row.blended)}`)
}
const keyword = report.keyword
const favors = keyword.ngram.recall >= keyword.fts.recall + 0.05 && keyword.ngram.precision + 1e-9 >= keyword.fts.precision
const verdict = favors ? 'keyword-metrics-favor-ngram-but-default-stays-off' : 'keep-off'
console.log(`verdict=${verdict}`)
ok(groups.every((g) => [report[g].fts, report[g].ngram, report[g].blended].every((m) => m.recall >= 0 && m.recall <= 1 && m.precision >= 0 && m.precision <= 1 && Number.isFinite(m.medianMs) && m.medianMs >= 0)), 'benchmark: recall, precision, and latency are finite')
ok(verdict === 'keep-off' || verdict.startsWith('keyword-metrics-favor-ngram'), `benchmark verdict recorded (${verdict})`)

const off = await semantic.retrieve('bench', null, 'zebra codename', { limit: 5 })
ok(off.some((h) => h.text.includes('zebra')) && off.every((h) => !h.via.includes('ngram')), 'retrieve: flag off uses FTS and does not mark ngram')
process.env.MEMORY_NGRAM = 'on'
const on = await semantic.retrieve('bench', null, 'zebra codename', { limit: 5 })
ok(on.some((h) => h.via.includes('ngram')) && on.some((h) => h.text.includes('zebra')), `retrieve: MEMORY_NGRAM=on adds an ngram voter (${on.map((h) => h.via.join('+')).join(' | ')})`)
const empty = await semantic.retrieve('bench', null, '   ', { limit: 5 })
ok(empty.length === 0, 'retrieve: a blank query stays empty while the candidate is on')
delete process.env.MEMORY_NGRAM
ok(ngramRankEnabled() === false, 'candidate flag is off again at the end of the test')

rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} ngram check(s) FAILED` : `\nall ${passes} ngram checks passed`)
process.exit(failures ? 1 : 0)
