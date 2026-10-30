// Generator-verifier loop: Architect writes code (+ tests), Critic reviews it for stubs and edge cases,
// Executor runs the tests in the sandbox and feeds failures back, for up to N rounds.
// A passing result becomes a "fossil" under DATA_DIR/fossils/<id>/, is recorded in the chain, the knowledge graph
// and the semantic store, and its lesson is appended to the user's proven-patterns file, which later prompts include.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { db, now } from '../agent/db'
import { chat, type Msg } from '../agent/llm'
import { appendRecord } from './record'
import { indexDoc } from './semantic'
import { addModule } from './akashic'
import { runSandboxed, type ExecResult } from './sandbox'

db.exec(`
create table if not exists evolve_jobs(id text primary key, user_id text not null, task text not null, status text not null, rounds text, fossil_id text, error text, created_at integer, updated_at integer);
create table if not exists proven_patterns(id integer primary key autoincrement, user_id text not null, fossil_id text, name text, pattern text not null, created_at integer);
`)

const dataDir = () => process.env.DATA_DIR || './data'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const userKey = (userId: string) => sha('user:' + userId).slice(0, 12)
export const fossilsDir = () => `${dataDir()}/fossils`
const STUB = /\bTODO\b|\bFIXME\b|not\s+implemented|NotImplemented|unimplemented/i

const ARCHITECT = `You are ARCHITECT in a generator-verifier loop. Write a complete, working JavaScript ES module named solution.mjs for the task.
Rules: pure Node.js 24 (built-in modules only, no npm packages), no network, no reading files outside the working directory, no stubs, no TODOs, handle edge cases.
If no tests are provided, also write test.mjs: it imports from './solution.mjs', uses node:assert/strict, covers normal and edge cases, and exits non-zero on failure (an uncaught assertion is enough). Print "ALL TESTS PASSED" at the end.
Reply with fenced code blocks whose info string names the file, exactly like:
\`\`\`js file=solution.mjs
...
\`\`\`
\`\`\`js file=test.mjs
...
\`\`\`
Then two lines:
NAME: <short-kebab-case module name>
PATTERN: <one sentence: the reusable lesson or technique that made this work>`

const CRITIC = `You are CRITIC, an adversarial reviewer in a generator-verifier loop. Inspect the solution and its tests for: stubs or placeholders, missing edge cases, broken or fragile logic, and tests that do not really check the task (trivially passing, testing the wrong thing).
Reply with JSON only: {"blocking": true|false, "issues": ["short concrete issue", ...]}. Set blocking=true only for problems that make the solution wrong or the tests meaningless.`

type Round = { round: number; files?: string[]; parseError?: string; critic?: { blocking: boolean; issues: string[] }; stub?: boolean; exec?: Omit<ExecResult, 'stdout' | 'stderr'> & { stdout: string; stderr: string } }
export type EvolveInput = { task: string; tests?: string; maxRounds?: number; timeoutMs?: number }

function parseFiles(text: string) {
  const files: Record<string, string> = {}
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  const unnamed: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const named = m[1].match(/(solution|test)\.mjs/)?.[0] || m[2].split('\n')[0].match(/^\s*\/\/\s*(?:file:?\s*)?((?:solution|test)\.mjs)/)?.[1]
    if (named) files[named] = m[2]; else unnamed.push(m[2])
  }
  if (!files['solution.mjs'] && unnamed.length) files['solution.mjs'] = unnamed.shift()!
  if (!files['test.mjs'] && unnamed.length) files['test.mjs'] = unnamed.shift()!
  const name = (text.match(/^\s*NAME:\s*(.+)$/im)?.[1] || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  const pattern = (text.match(/^\s*PATTERN:\s*(.+)$/im)?.[1] || '').trim().slice(0, 400)
  return { files, name, pattern }
}
function parseCritic(text: string): { blocking: boolean; issues: string[] } {
  const j = text.match(/\{[\s\S]*\}/)?.[0]
  try { const o = JSON.parse(j || ''); return { blocking: !!o.blocking, issues: (Array.isArray(o.issues) ? o.issues : []).map((x: any) => String(x).slice(0, 300)).slice(0, 8) } } catch {}
  return { blocking: false, issues: text.trim() ? [text.trim().slice(0, 300)] : [] }
}
async function ask(system: string, user: string) {
  const msgs: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }]
  const r = await chat(msgs, [], process.env.EVOLVE_MODEL)
  if (r.provider === 'mock') throw new Error('the verifier loop needs a real LLM provider (none configured)')
  return r.content || ''
}

const setJob = (id: string, f: Record<string, any>) => {
  const k = Object.keys(f)
  db.prepare(`update evolve_jobs set ${k.map((x) => `${x}=?`).join(',')}, updated_at=? where id=?`).run(...k.map((x) => (typeof f[x] === 'object' && f[x] !== null ? JSON.stringify(f[x]) : f[x])), now(), id)
}
const running = new Map<string, Promise<void>>()

export function startEvolve(userId: string, input: EvolveInput) {
  const task = String(input.task || '').trim().slice(0, 4000)
  if (!task) throw new Error('task required')
  const mine = [...running.keys()].filter((id) => (db.prepare('select user_id from evolve_jobs where id=?').get(id) as any)?.user_id === userId)
  if (mine.length) throw new Error('a verifier job is already running for you; wait for it to finish')
  if (running.size >= 2) throw new Error('verifier is busy; try again in a minute')
  const id = 'evo_' + randomUUID().slice(0, 12)
  db.prepare("insert into evolve_jobs(id,user_id,task,status,rounds,created_at,updated_at) values(?,?,?,'running','[]',?,?)").run(id, userId, task, now(), now())
  appendRecord('evolve.start', { jobId: id, task, testsProvided: !!input.tests, maxRounds: input.maxRounds }, { userId })
  const p = loop(id, userId, { ...input, task }).finally(() => running.delete(id))
  running.set(id, p)
  return { jobId: id }
}

export async function waitEvolve(userId: string, id: string, timeoutMs = 170_000) {
  const p = running.get(id)
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, timeoutMs))])
  return getEvolve(userId, id)
}

export function getEvolve(userId: string, id: string) {
  const j = db.prepare('select * from evolve_jobs where id=? and user_id=?').get(id, userId) as any
  if (!j) return null
  return { id: j.id, task: j.task, status: j.status, rounds: JSON.parse(j.rounds || '[]'), fossilId: j.fossil_id || undefined, error: j.error || undefined, createdAt: j.created_at, updatedAt: j.updated_at }
}
export const listEvolve = (userId: string) => db.prepare('select id,task,status,fossil_id,error,created_at from evolve_jobs where user_id=? order by created_at desc limit 50').all(userId)

async function loop(jobId: string, userId: string, input: EvolveInput) {
  const maxRounds = Math.min(Math.max(Number(input.maxRounds) || 4, 1), 6)
  const fixedTests = input.tests ? String(input.tests).slice(0, 50_000) : ''
  const rounds: Round[] = []
  let feedback = ''
  let last: { files: Record<string, string>; name: string; pattern: string } | null = null
  try {
    for (let n = 1; n <= maxRounds; n++) {
      const round: Round = { round: n }
      rounds.push(round)
      const prompt = [`Task:\n${input.task}`, fixedTests ? `Fixed tests (test.mjs, you cannot change them; make them pass):\n\`\`\`js\n${fixedTests}\n\`\`\`` : '',
        last ? `Your previous solution.mjs:\n\`\`\`js\n${last.files['solution.mjs']}\n\`\`\`` + (fixedTests ? '' : `\nYour previous test.mjs:\n\`\`\`js\n${last.files['test.mjs']}\n\`\`\``) : '',
        feedback ? `Feedback from the previous round (fix all of it):\n${feedback}` : ''].filter(Boolean).join('\n\n')
      const parsed = parseFiles(await ask(ARCHITECT, prompt))
      if (fixedTests) parsed.files['test.mjs'] = fixedTests
      if (!parsed.files['solution.mjs'] || !parsed.files['test.mjs']) {
        round.parseError = 'Architect reply did not contain solution.mjs and test.mjs code blocks'
        feedback = round.parseError + '. Use the exact fenced block format.'
        setJob(jobId, { rounds }); continue
      }
      last = parsed
      round.files = Object.keys(parsed.files)
      round.stub = STUB.test(parsed.files['solution.mjs'])
      const [critic, exec] = await Promise.all([
        ask(CRITIC, `Task:\n${input.task}\n\nsolution.mjs:\n\`\`\`js\n${parsed.files['solution.mjs']}\n\`\`\`\n\ntest.mjs:\n\`\`\`js\n${parsed.files['test.mjs']}\n\`\`\``).then(parseCritic).catch((e) => ({ blocking: false, issues: ['critic unavailable: ' + e.message] })),
        runSandboxed({ 'solution.mjs': parsed.files['solution.mjs'], 'test.mjs': parsed.files['test.mjs'] }, 'test.mjs', { timeoutMs: input.timeoutMs })
      ])
      round.critic = critic
      round.exec = { ...exec, stdout: exec.stdout.slice(-1500), stderr: exec.stderr.slice(-3000) }
      appendRecord('evolve.round', { jobId, round: n, passed: exec.passed, exitCode: exec.exitCode, timedOut: exec.timedOut, stub: round.stub, critic, stderr: exec.stderr.slice(-1500), solutionSha256: sha(parsed.files['solution.mjs']) }, { userId })
      setJob(jobId, { rounds })
      const blocking = round.stub || critic.blocking
      if (exec.passed && (!blocking || n === maxRounds)) {
        const fossilId = saveFossil(userId, jobId, input.task, parsed, rounds, critic)
        setJob(jobId, { status: 'passed', fossil_id: fossilId, rounds })
        return
      }
      feedback = [
        !exec.passed ? `Executor: tests FAILED (exit ${exec.exitCode}${exec.timedOut ? ', timed out' : ''}). stderr tail:\n${exec.stderr.slice(-2000)}\nstdout tail:\n${exec.stdout.slice(-500)}` : 'Executor: tests passed, but the review below found blocking problems.',
        round.stub ? 'Static check: the solution contains stub/TODO/placeholder markers. Remove them and implement fully.' : '',
        critic.issues.length ? `Critic${critic.blocking ? ' (BLOCKING)' : ''}:\n- ${critic.issues.join('\n- ')}` : ''
      ].filter(Boolean).join('\n\n')
    }
    setJob(jobId, { status: 'failed', error: `tests did not pass in ${maxRounds} rounds`, rounds })
    appendRecord('evolve.failed', { jobId, rounds: maxRounds }, { userId })
  } catch (e: any) {
    setJob(jobId, { status: 'error', error: String(e.message || e).slice(0, 500), rounds })
    appendRecord('evolve.error', { jobId, error: String(e.message || e).slice(0, 500) }, { userId })
  }
}

function saveFossil(userId: string, jobId: string, task: string, p: { files: Record<string, string>; name: string; pattern: string }, rounds: Round[], critic: { blocking: boolean; issues: string[] }) {
  const solSha = sha(p.files['solution.mjs'])
  const fossilId = `fsl_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${solSha.slice(0, 10)}`
  const dir = `${fossilsDir()}/${fossilId}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/solution.mjs`, p.files['solution.mjs'])
  writeFileSync(`${dir}/test.mjs`, p.files['test.mjs'])
  const name = p.name || 'module-' + solSha.slice(0, 6)
  const pattern = p.pattern || `Verified solution for: ${task.slice(0, 160)}`
  const meta = { fossilId, jobId, owner: userKey(userId), name, task, pattern, rounds: rounds.length, solutionSha256: solSha, testSha256: sha(p.files['test.mjs']), criticNotes: critic.issues, acceptedWithCriticConcerns: critic.blocking, createdAt: new Date().toISOString() }
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2))
  const rec = appendRecord('fossil', meta, { userId })
  addModule(userId, { name, language: 'javascript', fossilId, sha256: solSha, description: `${task.slice(0, 300)} | pattern: ${pattern}`, tests: `test.mjs sha256 ${meta.testSha256.slice(0, 12)} passed in sandbox` })
  indexDoc({ userId, scope: 'shared', kind: 'fossil', text: `Verified module "${name}" (fossil ${fossilId}) for task: ${task.slice(0, 600)}. Pattern: ${pattern}`, source: `fossil:${fossilId}:${userKey(userId)}` })
  db.prepare('insert into proven_patterns(user_id,fossil_id,name,pattern,created_at) values(?,?,?,?,?)').run(userId, fossilId, name, pattern, now())
  mkdirSync(`${dataDir()}/proven-patterns`, { recursive: true })
  appendFileSync(`${dataDir()}/proven-patterns/${userKey(userId)}.md`, `- ${new Date().toISOString().slice(0, 10)} **${name}** (${fossilId}, record #${rec?.seq ?? '?'}): ${pattern}\n`)
  return fossilId
}

export function getFossil(userId: string, id: string) {
  if (!/^fsl_[\w]+$/.test(id)) return null
  const row = db.prepare('select fossil_id from kg_modules where user_id=? and fossil_id=?').get(userId, id)
  const dir = `${fossilsDir()}/${id}`
  if (!row || !existsSync(dir)) return null
  return { meta: JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')), solution: readFileSync(`${dir}/solution.mjs`, 'utf8'), test: readFileSync(`${dir}/test.mjs`, 'utf8') }
}
export const listFossils = (userId: string) => db.prepare("select name,fossil_id,sha256,description,created_at from kg_modules where user_id=? and fossil_id is not null order by id desc limit 100").all(userId)
export const listPatterns = (userId: string) => db.prepare('select id,fossil_id,name,pattern,created_at from proven_patterns where user_id=? order by id desc limit 100').all(userId)
export function deleteFossil(userId: string, id: string) {
  if (!/^fsl_[\w]+$/.test(id)) return false
  const c = Number(db.prepare('delete from kg_modules where user_id=? and fossil_id=?').run(userId, id).changes)
  if (!c) return false
  db.prepare('delete from proven_patterns where user_id=? and fossil_id=?').run(userId, id)
  db.prepare('delete from mem_docs where user_id=? and kind=? and source=?').run(userId, 'fossil', `fossil:${id}:${userKey(userId)}`)
  rmSync(`${fossilsDir()}/${id}`, { recursive: true, force: true })
  rewritePatternsFile(userId)
  appendRecord('fossil.delete', { fossilId: id }, { userId })
  return true
}
function rewritePatternsFile(userId: string) {
  const rows = db.prepare('select name,fossil_id,pattern,created_at from proven_patterns where user_id=? order by id').all(userId) as any[]
  mkdirSync(`${dataDir()}/proven-patterns`, { recursive: true })
  writeFileSync(`${dataDir()}/proven-patterns/${userKey(userId)}.md`, rows.map((r) => `- ${new Date(r.created_at).toISOString().slice(0, 10)} **${r.name}** (${r.fossil_id}): ${r.pattern}\n`).join(''))
}
export function deleteEvolve(userId: string, id: string) {
  if (running.has(id)) throw new Error('job is still running')
  return Number(db.prepare('delete from evolve_jobs where user_id=? and id=?').run(userId, id).changes) > 0
}
export function deletePattern(userId: string, id: number) {
  const ok = Number(db.prepare('delete from proven_patterns where user_id=? and id=?').run(userId, id).changes) > 0
  if (ok) rewritePatternsFile(userId)
  return ok
}

// Proven patterns block appended to agent system instructions (bounded)
export function patternsBlock(userId: string, maxChars = 1200) {
  const rows = db.prepare('select name,pattern from proven_patterns where user_id=? order by id desc limit 10').all(userId) as any[]
  let out = ''
  for (const r of rows) { const l = `- ${r.name}: ${r.pattern}\n`; if (out.length + l.length > maxChars) break; out += l }
  return out.trim()
}
