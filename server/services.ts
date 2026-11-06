import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { imageFetch } from './image-generation'

export { runFlux } from './image-generation'
export type { ImageResult, CostMode } from './image-generation'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_SYSTEM = 'You are a FLUX prompt engineer. Convert user ideas into detailed, photorealistic FLUX.1 schnell prompts. Be specific about lighting, camera, texture. Output only the prompt.'

// Prompt step. Engines, in order: Groq (GROQ_API_KEY), any OpenAI-compatible endpoint such as the
// Hostinger router (PROMPT_LLM_BASE_URL/PROMPT_LLM_API_KEY, falling back to OPENAI_BASE_URL/OPENAI_API_KEY),
// otherwise a fixed template (mocked=true). PROMPT_LLM=groq|openai|template forces one.
export async function runLlama(prompt: string, system = DEFAULT_SYSTEM): Promise<{ text: string; mocked?: boolean; engine: string }> {
  const groqKey = process.env.GROQ_API_KEY
  const oaBase = process.env.PROMPT_LLM_BASE_URL || process.env.OPENAI_BASE_URL
  const oaKey = process.env.PROMPT_LLM_API_KEY || process.env.OPENAI_API_KEY
  const pick = process.env.PROMPT_LLM || (groqKey ? 'groq' : oaBase && oaKey ? 'openai' : 'template')
  if (pick === 'template' || (pick === 'groq' && !groqKey) || (pick === 'openai' && !(oaBase && oaKey))) {
    return { text: `Photorealistic ${prompt.slice(0, 200)}, UGC mirror selfie, iPhone flash, natural skin texture, 8k, ultra detailed`, mocked: true, engine: 'template' }
  }
  const url = pick === 'groq' ? GROQ_URL : `${oaBase!.replace(/\/$/, '')}/chat/completions`
  const model = pick === 'groq' ? (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile') : (process.env.PROMPT_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini')
  const headers: Record<string, string> = { Authorization: `Bearer ${pick === 'groq' ? groqKey : oaKey}`, 'Content-Type': 'application/json' }
  if (pick === 'openai' && process.env.OPENAI_USER_AGENT) headers['User-Agent'] = process.env.OPENAI_USER_AGENT
  const r = await fetch(url, {
    method: 'POST', headers, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 400, temperature: 0.8 })
  })
  const data: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${pick} prompt LLM failed ${r.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`${pick} prompt LLM returned no text`)
  return { text, engine: `${pick}:${model}` }
}

function removeInWorker(input: Buffer, timeoutMs = 180000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL('./remover-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []; let err = ''
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('background removal timed out')) }, timeoutMs)
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => { clearTimeout(t); reject(e) })
    p.on('close', (code, sig) => {
      clearTimeout(t)
      const png = Buffer.concat(out)
      if (code === 0 && png.length) resolve(png)
      else reject(new Error(`remover worker exited ${code ?? sig}: ${err.trim().split('\n').pop()?.slice(0, 200) || ''}`))
    })
    p.stdin.end(input)
  })
}

export async function runRemover(input: Buffer): Promise<{ png: Buffer; engine: string }> {
  try {
    return { png: await removeInWorker(input), engine: 'imgly-isnet-local' }
  } catch (err) {
    console.warn('Local background removal failed, passing image through', err)
    return { png: await sharp(input).ensureAlpha().png().toBuffer(), engine: 'passthrough' }
  }
}

async function replicateUpscale(input: Buffer, scale: number): Promise<Buffer> {
  const token = process.env.REPLICATE_API_TOKEN!
  const version = process.env.REPLICATE_ESRGAN_VERSION || 'nightmareai/real-esrgan'
  const png = await sharp(input).png().toBuffer()
  const versioned = version.includes(':')
  const url = versioned ? 'https://api.replicate.com/v1/predictions' : `https://api.replicate.com/v1/models/${version}/predictions`
  const body: Record<string, unknown> = { input: { image: `data:image/png;base64,${png.toString('base64')}`, scale: Math.min(scale, 4), face_enhance: false } }
  if (versioned) body.version = version.split(':')[1]
  const r = await imageFetch(url, {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
    body: JSON.stringify(body)
  })
  let pred: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Replicate failed ${r.status}: ${JSON.stringify(pred).slice(0, 200)}`)
  for (let i = 0; i < 60 && pred && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
    await new Promise((res) => setTimeout(res, 2000))
    pred = await (await imageFetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } })).json()
  }
  if (pred?.status !== 'succeeded') throw new Error(`Replicate prediction ${pred?.status}: ${pred?.error || ''}`)
  const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output
  const ir = await imageFetch(outUrl)
  if (!ir.ok) throw new Error(`Replicate output ${ir.status}`)
  return Buffer.from(await ir.arrayBuffer())
}

export async function runUpscaler(input: Buffer, scale = 4): Promise<{ png: Buffer; from: string; to: string; engine: string; kind: 'resize' | 'ai-upscale' }> {
  const meta = await sharp(input).metadata()
  const w = meta.width || 1024
  const h = meta.height || 1024
  const to = `${w * scale}x${h * scale}`
  let engine = 'sharp-lanczos3-resize'
  let kind: 'resize' | 'ai-upscale' = 'resize'
  let png: Buffer | null = null

  // A Replicate token alone must not spend money. ENABLE_PAID_REPLICATE=1 is the explicit opt-in.
  if (process.env.ENABLE_PAID_REPLICATE === '1' && process.env.REPLICATE_API_TOKEN) {
    try {
      const ai = await replicateUpscale(input, scale)
      png = await sharp(ai).resize(w * scale, h * scale, { kernel: 'lanczos3' }).png({ compressionLevel: 8 }).toBuffer()
      engine = 'replicate-real-esrgan'
      kind = 'ai-upscale'
    } catch (err) {
      console.warn('Replicate upscale failed, falling back to sharp resize', err)
    }
  }
  if (!png) {
    png = await sharp(input).resize(w * scale, h * scale, { kernel: 'lanczos3', fastShrinkOnLoad: false }).png({ compressionLevel: 8 }).toBuffer()
  }
  return { png, from: `${w}x${h}`, to, engine, kind }
}
