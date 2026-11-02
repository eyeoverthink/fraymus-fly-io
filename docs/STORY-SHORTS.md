# Story Shorts (offline pipeline)

Faceless "cartoon story" vertical shorts, abstracted from the workflow in
[Viral AI Cartoon Story Shorts](https://youtu.be/6Vse0U73BzQ) and rebuilt on free, offline tools.
The original used paid cloud models (Opus, Nano Banana Pro, Wan, ElevenLabs); here every stage runs in the
2 GB Fly machine with FFmpeg / sharp / espeak-ng, and the GPU-only stages can be swapped in from the PC per shot.

## Stages (`server/shorts`)

| # | Stage  | Input → output | Check (stops the run when it fails, so later work isn't wasted) | Tool (Fly, free/offline) | Better quality, on the PC/Pi |
|---|--------|----------------|------------------------------------------------------------------|--------------------------|------------------------------|
| 0 | study  | reference short → length, cut rate, loudness, warmth, 8-still contact sheet | – | ffmpeg scene detect + ebur128, sharp | – |
| – | rules / cast | rulebook (18 rules) + cast bible | cast has a main character | JSON (`DEFAULT_RULES`, `DEFAULT_CAST`) | – |
| 1 | script | narration → length / hook / "you" report | advisory only | `checkScript` | your own LLM, fact-checked |
| 2 | plan   | narration → 12 shots (line, picture prompt, camera move, sound, cast) | narration word for word, opening + last line kept, main character in ≥60% of shots, ≤3 characters, valid moves | `buildPlan` + `verifyPlan` | – |
| 3 | voice  | narration → voice track + word timings | uploaded Whisper timings must match the script word for word | Piper (if `PIPER_MODEL`) → espeak-ng → silent guide | Piper/any TTS + faster-whisper word timings, uploaded |
| 4 | images | prompt → one 9:16 picture per shot | 9:16, not a plain background, warm light | sharp storyboard frame | SD/Flux/ComfyUI on the GPU, uploaded per shot |
| 5 | clips  | picture → clip as long as the shot | size, length, start→end drift (character stays itself) | ffmpeg zoompan camera move | Wan / LTX image-to-video, uploaded per shot |
| 6 | sfx    | sound idea → low effect per shot | – | ffmpeg-synthesised effects (license-free) | your own SFX, uploaded |
| 7 | edit   | clips + voice + sfx → final MP4 | – | ffmpeg concat, cuts just before each shot's first word, burned-in ASS captions, loudnorm −14 LUFS | – |
| 8 | qa     | final → report | cut drift ≤0.25 s, −16..−12 LUFS, length follows the voice, plan passed | ffprobe / ebur128 | watch it back |

Every stage is saved to the **Library** as a `pipeline` item (`shorts:<runId>:<stage>`, JSON snapshot), and every
file (pictures, clips, sfx, voice, final) as an image/media item tagged `shorts`, `<stage>`, `<runId>`. Events go to the
episodic record (`shorts.create`, `shorts.stage`, `shorts.study`). Deleting a run removes only its work files.

## API (workspace token / Clerk)

```
GET    /api/shorts/status                      tools found (ffmpeg, espeak, piper), stages, rules, cast
POST   /api/shorts/plan        {story,title?,shots?}             plan preview, nothing rendered
POST   /api/shorts/runs        {story,title?,shots?,cast?,rules?,style?,width?,height?,fps?,strict?,until?}  (?wait=1)
GET    /api/shorts/runs[/:id]
POST   /api/shorts/runs/:id/run   {from?,until?}                  resume / redo from a stage (?wait=1)
PATCH  /api/shorts/runs/:id/plan  {shots:[{n,picture?,motion?,sfx?,cast?}]}   remake shots
POST   /api/shorts/runs/:id/assets/{image|clip|voice|sfx}/:n      multipart file (voice uses n=0)
POST   /api/shorts/runs/:id/timings {words:[{w,start,end}]}      Whisper word timings
DELETE /api/shorts/runs/:id
POST   /api/shorts/study                        multipart reference video
```

Agent tools: `shorts_plan` (safe) and `shorts_make` (needs approval).

Tip from the video, built in: run `until: "images"`, look at the pictures, upload replacements, then continue
`{from: "clips"}` — clips are the expensive step.

## PC helper (optional, not run on Fly)

`scripts/shorts-pc-worker.py` uploads a folder of GPU renders (`shot-1.png`, `shot-1.mp4`, `voice.wav`) to a run and,
if `faster-whisper` is installed, sends word timings for `voice.wav`. See the script header.

## Fly

The Dockerfile installs `ffmpeg espeak-ng fonts-dejavu-core` (~+150 MB image). One render at a time
(`SHORTS_MAX_CONCURRENT=1`, `SHORTS_FFMPEG_THREADS=2`); a 1080×1920 render peaks under ~1 GB for ffmpeg.
Optional: `PIPER_BIN` + `PIPER_MODEL` (a free Piper voice on the /data volume) for a more natural voice.
