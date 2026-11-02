// Voice engine order for Story Shorts: Piper (natural) first, espeak-ng next, silent guide last; a failing engine falls
// through with the reason. Run: npx tsx scripts/test-voice.ts  (set PIPER_BIN/PIPER_MODEL to also test real Piper).
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (c: any, m: string) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) failures++ }
const dir = mkdtempSync(join(tmpdir(), 'voice-test-'))
const TEXT = "It's June 1859 on San Juan Island, and a pig is eating your potatoes."
const realPiper = process.env.PIPER_MODEL && existsSync(process.env.PIPER_MODEL) ? { bin: process.env.PIPER_BIN || 'piper', model: process.env.PIPER_MODEL } : null

try {
  // a broken "piper" with a model present: must fall back (espeak-ng or silent guide) and say why
  const fake = join(dir, 'piper-broken'); writeFileSync(fake, '#!/bin/sh\n[ "$1" = "--help" ] && exit 0\necho boom >&2; exit 3\n'); chmodSync(fake, 0o755)
  const model = join(dir, 'm.onnx'); writeFileSync(model, 'x'); writeFileSync(model + '.json', '{}')
  process.env.PIPER_BIN = fake; process.env.PIPER_MODEL = model
  const m = await import('../server/shorts/media.ts')
  const t = await m.toolStatus()
  ok(t.piper === true && t.voice === 'piper' && t.piperVoice === 'm', 'status: piper preferred when binary + model (+ .json) exist')
  const v = await m.synthVoice(TEXT, join(dir, 'a.wav'), 5)
  ok(v.engine !== 'piper' && /piper failed \(exit 3\)/.test(v.fallback || ''), `fallback: broken piper falls back to ${v.engine} with the reason`)
  ok(v.seconds > 0.5, `fallback: produced ${v.seconds.toFixed(2)}s of audio`)
  rmSync(model + '.json')
  ok((await m.toolStatus()).piper === false, 'status: model without its .json config is not reported as piper')

  if (realPiper) {
    process.env.PIPER_BIN = realPiper.bin; process.env.PIPER_MODEL = realPiper.model
    const r = await m.synthVoice(TEXT, join(dir, 'b.wav'), 5)
    ok(r.engine === 'piper' && r.seconds > 2 && !r.fallback, `piper: real voice synthesised (${r.seconds.toFixed(2)}s)`)
  } else console.log('skip piper: PIPER_MODEL not set')
} catch (e) { console.error(e); failures++ } finally { rmSync(dir, { recursive: true, force: true }) }
console.log(failures ? `\n${failures} voice check(s) FAILED` : '\nAll voice checks passed')
process.exit(failures ? 1 : 0)
