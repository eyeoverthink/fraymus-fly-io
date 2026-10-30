// Self-contained: boots throwaway servers (temp SQLite, mock LLM) and checks the workspace access gate.
// - token mode: unauthenticated /api/* and the workspace UI are denied; Bearer and /login cookie work
// - closed mode (no WORKSPACE_ACCESS_TOKEN): /api/* denied even with a guess (fail closed)
// - always public: /health, /enhance, /buyer/*, /webhooks/shopify (HMAC still enforced)
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRET = 'test_whsec_' + randomBytes(8).toString('hex')
const TOKEN = randomBytes(24).toString('hex')
const SHOP = 'eyeoverthink.myshopify.com'
let failures = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }

async function boot(extra) {
  const port = String(3900 + Math.floor(Math.random() * 300))
  const dataDir = mkdtempSync(join(tmpdir(), 'gate-test-'))
  const env = { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dataDir, LLM_PROVIDERS: 'none', SCHEDULER: 'off',
    SHOPIFY_WEBHOOK_SECRET: SECRET, NODE_ENV: 'test', WORKSPACE_AUTH: '', WORKSPACE_ACCESS_TOKEN: '',
    GROQ_API_KEY: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', CLERK_SECRET_KEY: '', SUPABASE_URL: '', FREE_CREDITS: '', ...extra }
  const p = spawn('npx', ['tsx', 'server/index.ts'], { env, stdio: process.env.DEBUG ? 'inherit' : 'ignore' })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) }
  return { base, stop: () => { p.kill(); setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 800) } }
}
const get = (base, path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' })
const hook = async (base, secret) => {
  const body = JSON.stringify({ id: Date.now(), line_items: [] })
  const r = await fetch(base + '/webhooks/shopify', { method: 'POST', body, headers: { 'Content-Type': 'application/json',
    'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Webhook-Id': String(Math.random()),
    'X-Shopify-Hmac-Sha256': createHmac('sha256', secret).update(body).digest('base64') } })
  return r.status
}

async function publicRoutes(base, label) {
  const h = await get(base, '/health'); ok(h.status === 200, `${label}: /health 200 (${h.status})`)
  const e = await get(base, '/enhance'); ok(e.status === 200, `${label}: /enhance 200 (${e.status})`)
  const bm = await get(base, '/buyer/me'); ok(bm.status !== 404 && bm.status !== 302 && !(await bm.clone().text()).includes('Workspace access'), `${label}: /buyer/me not gated by workspace (${bm.status})`)
  ok((await hook(base, 'wrong-secret')) === 401, `${label}: webhook bad signature -> 401`)
  ok((await hook(base, SECRET)) === 200, `${label}: webhook good signature -> 200`)
}

// --- token mode
{
  const s = await boot({ WORKSPACE_ACCESS_TOKEN: TOKEN })
  try {
    ok((await (await get(s.base, '/health')).json()).workspaceAuth === 'token', 'token: /health reports workspaceAuth=token')
    for (const p of ['/api/agents', '/api/agent/status', '/api/me', '/api/agent/threads', '/api/access']) {
      const r = await get(s.base, p); ok(r.status === 401, `token: unauthenticated GET ${p} -> 401 (${r.status})`)
    }
    const run = await fetch(s.base + '/api/agent/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'genesis', message: 'hi' }) })
    ok(run.status === 401, `token: unauthenticated POST /api/agent/runs -> 401 (${run.status})`)
    const wrong = await get(s.base, '/api/agents', { Authorization: 'Bearer ' + randomBytes(24).toString('hex') })
    ok(wrong.status === 401, 'token: wrong bearer -> 401')
    const good = await get(s.base, '/api/agents', { Authorization: 'Bearer ' + TOKEN })
    ok(good.status === 200, `token: correct bearer -> 200 (${good.status})`)
    const login = await fetch(s.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=nope' })
    ok(login.status === 401, `token: /login wrong token -> 401 (${login.status})`)
    const login2 = await fetch(s.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + TOKEN })
    const setCookie = login2.headers.get('set-cookie') || ''
    ok(login2.status === 303 && /ws_access=[^;]+;.*HttpOnly/i.test(setCookie) && !setCookie.includes(TOKEN), `token: /login correct -> 303 + httpOnly cookie without raw token (${login2.status})`)
    const cookie = setCookie.split(';')[0]
    const viaCookie = await get(s.base, '/api/agents', { Cookie: cookie })
    ok(viaCookie.status === 200, `token: cookie -> /api/agents 200 (${viaCookie.status})`)
    const forged = await get(s.base, '/api/agents', { Cookie: 'ws_access=' + TOKEN })
    ok(forged.status === 401, 'token: raw token as cookie -> 401')
    const lp = await get(s.base, '/login'); ok(lp.status === 200 && (await lp.text()).includes('access token'), 'token: GET /login shows the form')
    await publicRoutes(s.base, 'token')
  } finally { s.stop() }
}

// --- closed mode (no token configured): fail closed
{
  const s = await boot({})
  try {
    ok((await (await get(s.base, '/health')).json()).workspaceAuth === 'closed', 'closed: /health reports workspaceAuth=closed')
    for (const p of ['/api/agents', '/api/me', '/api/agent/status']) {
      const r = await get(s.base, p); ok(r.status === 401, `closed: GET ${p} -> 401 (${r.status})`)
    }
    const r = await get(s.base, '/api/agents', { Authorization: 'Bearer ' + 'x'.repeat(48) })
    ok(r.status === 401, 'closed: any bearer -> 401')
    const short = await boot({ WORKSPACE_ACCESS_TOKEN: 'short' })
    try { ok((await get(short.base, '/api/agents', { Authorization: 'Bearer short' })).status === 401, 'closed: token under 24 chars is ignored -> 401') } finally { short.stop() }
    await publicRoutes(s.base, 'closed')
  } finally { s.stop() }
}

// --- clerk mode with the access-token fallback (fake sk_test_ key: no Clerk network call unless a JWT is sent)
{
  const s = await boot({ CLERK_SECRET_KEY: 'sk_test_' + randomBytes(24).toString('hex'), WORKSPACE_ACCESS_TOKEN: TOKEN })
  try {
    const h = await (await get(s.base, '/health')).json()
    ok(h.workspaceAuth === 'clerk' && h.clerk === true && h.accessToken === true, 'clerk: /health reports clerk + accessToken')
    for (const p of ['/api/agents', '/api/me', '/api/agent/status']) {
      const r = await get(s.base, p); ok(r.status === 401, `clerk: unauthenticated GET ${p} -> 401 (${r.status})`)
    }
    ok((await get(s.base, '/api/agents', { Authorization: 'Bearer ' + randomBytes(24).toString('hex') })).status === 401, 'clerk: wrong bearer -> 401')
    ok((await get(s.base, '/api/agents', { Authorization: 'Bearer a.b.c' })).status === 401, 'clerk: invalid JWT -> 401')
    const good = await get(s.base, '/api/agents', { Authorization: 'Bearer ' + TOKEN })
    ok(good.status === 200, `clerk: access-token bearer still -> 200 (${good.status})`)
    const lp = await get(s.base, '/login'); ok(lp.status === 200 && (await lp.text()).includes('access token'), 'clerk: GET /login still shows the token form')
    const login = await fetch(s.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + TOKEN })
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    ok(login.status === 303 && cookie.startsWith('ws_access='), `clerk: /login correct -> 303 + cookie (${login.status})`)
    ok((await get(s.base, '/api/agents', { Cookie: cookie })).status === 200, 'clerk: cookie -> /api/agents 200')
    const ui = await get(s.base, '/'); ok(ui.status !== 302, `clerk: workspace UI served for Clerk sign-in, not redirected (${ui.status})`)
    await publicRoutes(s.base, 'clerk')
  } finally { s.stop() }
}

console.log(failures ? `\n${failures} FAILED` : '\nall access-gate checks passed')
process.exit(failures ? 1 : 0)
