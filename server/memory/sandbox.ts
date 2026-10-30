// Executor sandbox: runs generated JavaScript in a separate child process, never in the server process.
// Layers (each used when the host allows it; /api/evolve/status reports which are active):
//  - fresh temp dir per run, deleted afterwards; empty environment (no secrets inherited)
//  - Node permission model: fs read/write limited to the temp dir, no child processes, workers, addons or inspector
//  - network: own empty network namespace (unshare -n, needs root, true on Fly) + a preload that disables net/http/fetch/dns
//  - unprivileged uid/gid 65534 (setpriv), prlimit caps on CPU seconds, file size, open files, processes
//  - wall-clock timeout (kills the whole process group), V8 heap cap, stdout/stderr capped
import { spawn, spawnSync } from 'node:child_process'
import { chownSync, mkdtempSync, rmSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT_CAP = 64 * 1024
const GUARD = `// sandbox guard: no network from inside the sandbox
const deny = (n) => function () { throw new Error('sandbox: blocked (' + n + ')') }
for (const m of ['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'child_process', 'cluster', 'worker_threads', 'inspector']) {
  try {
    const mod = (await import('node:' + m)).default
    for (const k of Object.keys(mod)) if (typeof mod[k] === 'function' && /^[a-z]/.test(k) && !/^(is|_)/.test(k)) { try { mod[k] = deny(m + '.' + k) } catch {} }
    if (mod.Socket?.prototype) mod.Socket.prototype.connect = deny(m + '.Socket.connect')
    if (mod.Server?.prototype?.listen) mod.Server.prototype.listen = deny(m + '.Server.listen')
  } catch {}
}
for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { Object.defineProperty(globalThis, g, { value: deny(g), writable: false, configurable: false }) } catch {} }
try { process.binding = deny('process.binding'); process._linkedBinding = deny('process._linkedBinding'); process.dlopen = deny('process.dlopen') } catch {}
`

type Caps = { unshareNet: boolean; setpriv: boolean; prlimit: boolean; permission: boolean; root: boolean }
let caps: Caps | null = null
export function sandboxCaps(): Caps {
  if (caps) return caps
  const ok = (cmd: string, args: string[]) => { try { return spawnSync(cmd, args, { timeout: 5000, stdio: 'ignore' }).status === 0 } catch { return false } }
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  caps = {
    root,
    unshareNet: process.env.SANDBOX_NETNS !== 'off' && ok('unshare', ['-n', 'true']),
    setpriv: root && ok('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'true']),
    prlimit: ok('prlimit', ['--cpu=1', 'true']),
    permission: ok(process.execPath, ['--permission', '-e', '0'])
  }
  return caps
}
export function sandboxLevel() {
  const c = sandboxCaps()
  return { ...c, network: c.unshareNet ? 'none (empty network namespace)' : 'blocked by preload guard only', user: c.setpriv ? 'nobody (65534)' : 'same as server' }
}

export type ExecResult = { exitCode: number | null; passed: boolean; timedOut: boolean; stdout: string; stderr: string; durationMs: number; sandbox: string[] }

export async function runSandboxed(files: Record<string, string>, entry = 'test.mjs', opts: { timeoutMs?: number; memMb?: number } = {}): Promise<ExecResult> {
  const c = sandboxCaps()
  const timeoutMs = Math.min(opts.timeoutMs ?? 10_000, 60_000)
  const memMb = Math.min(opts.memMb ?? 128, 512)
  const dir = mkdtempSync(join(process.env.SANDBOX_TMP || tmpdir(), 'fossil-run-'))
  const layers: string[] = ['child-process', 'tmpdir', 'empty-env', `timeout ${timeoutMs}ms`, `heap ${memMb}MB`]
  try {
    for (const [name, body] of Object.entries(files)) {
      if (!/^[\w][\w.-]{0,60}\.(mjs|js|json|txt)$/.test(name)) throw new Error(`bad file name: ${name}`)
      writeFileSync(join(dir, name), String(body).slice(0, 200_000))
    }
    if (!(entry in files)) throw new Error(`entry ${entry} missing`)
    writeFileSync(join(dir, '_guard.mjs'), GUARD)
    if (c.setpriv) { chownSync(dir, 65534, 65534); for (const f of readdirSync(dir)) chownSync(join(dir, f), 65534, 65534); chmodSync(dir, 0o700) }

    const nodeArgs = [`--max-old-space-size=${memMb}`, '--disallow-code-generation-from-strings']
    if (c.permission) { nodeArgs.push('--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`); layers.push('node-permission(fs=tmpdir only, no child_process/worker/addons)') }
    nodeArgs.push(`--import=${join(dir, '_guard.mjs')}`, join(dir, entry))
    layers.push('net-guard-preload')
    let cmd = process.execPath, args = nodeArgs
    if (c.prlimit) { args = ['--cpu=' + Math.ceil(timeoutMs / 1000 + 1), '--fsize=' + 8 * 1024 * 1024, '--nofile=64', ...(c.setpriv ? ['--nproc=64'] : []), '--core=0', '--', cmd, ...args]; cmd = 'prlimit'; layers.push('prlimit(cpu,fsize,nofile,nproc)') }
    if (c.setpriv) { args = ['--reuid=65534', '--regid=65534', '--clear-groups', '--no-new-privs', '--', cmd, ...args]; cmd = 'setpriv'; layers.push('uid nobody') }
    if (c.unshareNet) { args = ['-n', '--', cmd, ...args]; cmd = 'unshare'; layers.push('netns(no network)') }

    const t0 = Date.now()
    return await new Promise<ExecResult>((resolve) => {
      const p = spawn(cmd, args, { cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, NODE_ENV: 'sandbox' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false
      const cap = (cur: string, d: Buffer) => (cur.length >= OUT_CAP ? cur : (cur + d.toString('utf8')).slice(0, OUT_CAP))
      p.stdout.on('data', (d) => { stdout = cap(stdout, d) })
      p.stderr.on('data', (d) => { stderr = cap(stderr, d) })
      const kill = () => { try { process.kill(-p.pid!, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
      const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
      p.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, passed: false, timedOut, stdout, stderr: stderr + String(e.message), durationMs: Date.now() - t0, sandbox: layers }) })
      p.on('close', (code) => {
        clearTimeout(timer); kill()
        resolve({ exitCode: code, passed: code === 0 && !timedOut, timedOut, stdout, stderr: timedOut ? stderr + `\n[sandbox] killed after ${timeoutMs}ms` : stderr, durationMs: Date.now() - t0, sandbox: layers })
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
