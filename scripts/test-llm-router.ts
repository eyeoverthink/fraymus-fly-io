// Chat router: xAI by default, reusing PROMPT_LLM_API_KEY. OpenAI only when LLM_PROVIDERS lists it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'llm-router-'))
const originalDataDir = process.env.DATA_DIR
process.env.DATA_DIR = dir

const KEYS = [
  'LLM_PROVIDERS', 'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_MODEL', 'PROMPT_LLM', 'PROMPT_LLM_API_KEY', 'PROMPT_LLM_BASE_URL', 'PROMPT_LLM_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL', 'OLLAMA_HOST',
  'EMBED_BASE_URL', 'EMBED_API_KEY', 'EMBED_ALLOW_OPENAI', 'EMBED_BACKEND'
]
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const reset = () => { for (const k of KEYS) delete process.env[k] }

let failures = 0, passes = 0
const ok = (c: unknown, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (c) passes++; else failures++ }

type Hit = { url: string; init?: RequestInit }
let hits: Hit[] = []
const origFetch = globalThis.fetch
function install(reply: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  hits = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    hits.push({ url, init })
    return reply(url, init)
  }) as typeof fetch
}
const chatJson = (text = 'hello') => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const auth = (hit?: Hit) => String((hit?.init?.headers as Record<string, string> | undefined)?.Authorization || '')

reset()
const llm = await import('../server/agent/llm.ts')
const services = await import('../server/services.ts')
const semantic = await import('../server/memory/semantic.ts')

const XAI_KEY = 'xai-test-key-0001'
const OA_KEY = 'sk-openai-test-key-0001'

try {
  process.env.PROMPT_LLM_API_KEY = XAI_KEY
  process.env.PROMPT_LLM_BASE_URL = 'https://api.x.ai/v1'
  process.env.PROMPT_LLM_MODEL = 'grok-4.20-0309-non-reasoning'
  process.env.PROMPT_LLM = 'openai'
  process.env.OPENAI_API_KEY = OA_KEY
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o-mini'
  delete process.env.GROQ_API_KEY
  delete process.env.LLM_PROVIDERS

  const status = await llm.providerStatus()
  ok(status.providers.map((p: { name: string }) => p.name).join(',') === 'xai,groq', `default order is xai,groq (${status.providers.map((p: { name: string }) => p.name).join(',')})`)
  ok(status.providers.find((p: { name: string }) => p.name === 'xai')?.configured === true, 'xAI is configured from PROMPT_LLM_API_KEY when the base URL is api.x.ai')
  ok(status.providers.find((p: { name: string }) => p.name === 'groq')?.configured === false, 'groq without a key is not configured')
  ok(!status.providers.some((p: { name: string }) => p.name === 'openai'), 'openai is absent from the default router')

  install(() => chatJson('from-xai'))
  const answered = await llm.chat([{ role: 'user', content: 'hi' }], [])
  ok(answered.provider === 'xai' && answered.model === 'grok-4.20-0309-non-reasoning', `chat uses xAI (${answered.provider} ${answered.model})`)
  ok(hits.length === 1 && hits[0].url === 'https://api.x.ai/v1/chat/completions', `chat URL is api.x.ai (${hits.map((h) => h.url).join(',')})`)
  ok(auth(hits[0]) === 'Bearer ' + XAI_KEY, 'chat sends the xAI prompt key')
  ok(auth(hits[0]) !== 'Bearer ' + OA_KEY, 'chat does not send OPENAI_API_KEY')
  const sent = JSON.parse(String(hits[0].init?.body))
  ok(sent.model === 'grok-4.20-0309-non-reasoning', 'chat model is PROMPT_LLM_MODEL')

  // Prompt step on the same Fly env also stays on xAI and does not fall through to api.openai.com.
  install(() => chatJson('prompt-ok'))
  const prompt = await services.runLlama('blue cup')
  ok(prompt.engine === 'xai:grok-4.20-0309-non-reasoning' && !prompt.mocked, `prompt step engine ${prompt.engine}`)
  ok(hits.length === 1 && hits[0].url === 'https://api.x.ai/v1/chat/completions', `prompt step URL (${hits.map((h) => h.url).join(',')})`)
  ok(auth(hits[0]) === 'Bearer ' + XAI_KEY, 'prompt step sends PROMPT_LLM_API_KEY')

  // OpenAI chat is opt-in. Listing it is what reaches api.openai.com.
  process.env.LLM_PROVIDERS = 'openai'
  install(() => chatJson('from-openai'))
  const opted = await llm.chat([{ role: 'user', content: 'hi' }], [])
  ok(opted.provider === 'openai' && hits[0].url === 'https://api.openai.com/v1/chat/completions', `explicit openai listing calls OpenAI (${hits[0]?.url})`)
  ok(auth(hits[0]) === 'Bearer ' + OA_KEY, 'opted-in openai sends OPENAI_API_KEY')

  // xAI failure does not continue into OpenAI unless openai is listed. Groq runs only with a key.
  process.env.LLM_PROVIDERS = 'xai,groq'
  process.env.GROQ_API_KEY = 'gsk-test-groq-0001'
  install((url) => url.includes('api.x.ai') ? new Response('no', { status: 500 }) : chatJson('from-groq'))
  const fell = await llm.chat([{ role: 'user', content: 'hi' }], [])
  ok(fell.provider === 'groq' && hits.some((h) => h.url.includes('api.groq.com')) && !hits.some((h) => h.url.includes('api.openai.com')), 'xAI failure falls through to Groq and not OpenAI')

  delete process.env.GROQ_API_KEY
  install(() => new Response('no', { status: 401 }))
  let routerErr = ''
  try { await llm.chat([{ role: 'user', content: 'hi' }], []) } catch (e: any) { routerErr = e.message }
  ok(/xai:/.test(routerErr) && !/openai/.test(routerErr) && hits.every((h) => h.url.includes('api.x.ai')), `configured xAI failure is reported and OpenAI is not tried (${routerErr.slice(0, 120)})`)

  // Embeddings do not reuse the OpenAI chat key unless EMBED_ALLOW_OPENAI=1.
  process.env.OPENAI_API_KEY = OA_KEY
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  delete process.env.EMBED_BASE_URL
  delete process.env.EMBED_API_KEY
  delete process.env.EMBED_ALLOW_OPENAI
  ok(semantic.embedStatus().backend === 'off', 'embeddings stay off when only OPENAI_* is set')
  process.env.EMBED_ALLOW_OPENAI = '1'
  ok(semantic.embedStatus().backend === 'openai-compatible', 'EMBED_ALLOW_OPENAI=1 is the embeddings opt-in')
} catch (e: any) {
  console.error('THREW', e)
  failures++
} finally {
  globalThis.fetch = origFetch
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
