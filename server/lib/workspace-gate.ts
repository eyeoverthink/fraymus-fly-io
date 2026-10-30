// Shared-secret gate for the workspace (agents, chat, canvas, /api/*).
// Modes:
//   clerk  - CLERK_SECRET_KEY set: Clerk sign-in handles /api auth; if WORKSPACE_ACCESS_TOKEN is also set,
//            the Bearer token / /login cookie still works as an owner fallback (acts as the local user)
//   token  - WORKSPACE_ACCESS_TOKEN set (>= 24 chars): Bearer header or the httpOnly cookie from /login
//   off    - WORKSPACE_AUTH=off and no token: open local user (local dev / test suites only)
//   closed - none of the above: every workspace request is denied (fail closed)
// Buyer routes (/enhance, /buyer/*), /webhooks/shopify, /outputs/*, /health and static assets are never gated.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const COOKIE = 'ws_access'
const MAX_AGE = 30 * 86400

export type GateMode = 'clerk' | 'token' | 'off' | 'closed'

const token = () => {
  const t = (process.env.WORKSPACE_ACCESS_TOKEN || '').trim()
  return t.length >= 24 ? t : ''
}
export const accessTokenConfigured = () => !!token()
export function gateMode(): GateMode {
  if (process.env.CLERK_SECRET_KEY) return 'clerk'
  if (token()) return 'token'
  if ((process.env.WORKSPACE_AUTH || '').toLowerCase() === 'off') return 'off'
  return 'closed'
}

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
// The cookie holds a derived value, never the raw token.
const sessionValue = (t: string) => createHmac('sha256', t).update('fraymus-workspace-session-v1').digest('base64url')

function cookie(req: FastifyRequest, name: string): string {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

// True when the request carries the shared access token (Bearer or /login cookie), or the gate is off.
// Works in token mode and, as an owner fallback, in clerk mode when WORKSPACE_ACCESS_TOKEN is set.
export function workspaceAuthorized(req: FastifyRequest): boolean {
  const mode = gateMode()
  if (mode === 'off') return true
  const t = token()
  if (!t) return false
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (bearer && eq(bearer, t)) return true
  const c = cookie(req, COOKIE)
  return !!c && eq(c, sessionValue(t))
}

// Same check for socket.io handshakes (raw Node request headers).
export function workspaceAuthorizedHeaders(headers: Record<string, any>): boolean {
  return workspaceAuthorized({ headers } as any)
}

const failures = new Map<string, { n: number; t: number }>()
const throttled = (ip: string) => { const f = failures.get(ip); return !!f && f.n >= 10 && Date.now() - f.t < 60_000 }
const fail = (ip: string) => { const f = failures.get(ip); failures.set(ip, { n: f && Date.now() - f.t < 60_000 ? f.n + 1 : 1, t: Date.now() }) }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const page = (msg = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workspace sign-in</title><style>
body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#151922;padding:28px;border-radius:12px;width:min(360px,90vw);box-shadow:0 8px 30px #0006}
h1{font-size:18px;margin:0 0 6px}p{font-size:13px;color:#9aa3b2;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a3140;background:#0b0d12;color:#e6e8ee;font-size:14px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#5b7cfa;color:#fff;font-size:14px;cursor:pointer}
.err{color:#ff7b7b;font-size:13px;margin-top:10px}</style></head><body>
<form method="post" action="/login"><h1>Fraymus workspace</h1><p>Paste your workspace access token.</p>
<input type="password" name="token" autocomplete="current-password" autofocus required placeholder="Access token">
<button type="submit">Open workspace</button>${msg ? `<div class="err">${esc(msg)}</div>` : ''}</form></body></html>`

const isHttps = (req: FastifyRequest) => req.protocol === 'https' || String(req.headers['x-forwarded-proto'] || '').startsWith('https') || process.env.NODE_ENV === 'production'

export function registerGateRoutes(app: FastifyInstance) {
  const html = (reply: FastifyReply, code: number, msg = '') =>
    reply.status(code).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(page(msg))

  app.get('/login', async (req, reply) => {
    const mode = gateMode()
    if (mode === 'off' || (mode === 'clerk' && !token()) || workspaceAuthorized(req)) return reply.redirect('/')
    return html(reply, 200, mode === 'closed' ? 'Workspace access is not configured on this server (WORKSPACE_ACCESS_TOKEN is missing).' : '')
  })

  app.post('/login', async (req, reply) => {
    if (!token()) return html(reply, 403, 'Workspace access is not configured on this server.')
    if (throttled(req.ip)) return html(reply, 429, 'Too many attempts. Wait a minute and try again.')
    const b: any = req.body || {}
    const given = String(b.token || '').trim()
    const t = token()
    if (!given || !eq(given, t)) { fail(req.ip); return html(reply, 401, 'That token is not right.') }
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_AGE}`, ...(isHttps(req) ? ['Secure'] : [])]
    reply.header('Set-Cookie', `${COOKIE}=${sessionValue(t)}; ${attrs.join('; ')}`)
    const wantsJson = String(req.headers.accept || '').includes('application/json') && !String(req.headers.accept || '').includes('text/html')
    return wantsJson ? reply.send({ ok: true }) : reply.redirect('/', 303)
  })

  app.get('/logout', async (_req, reply) =>
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`).redirect('/login'))
}
