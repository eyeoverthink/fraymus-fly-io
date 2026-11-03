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
| 3 | voice  | narration → voice track + word timings | uploaded Whisper timings must match the script word for word | Piper (if `PIPER_MODEL`) → espeak-ng → silent guide | VoiceStudio (your cloned / designed voice) or any TTS + word timings, uploaded by the PC worker |
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

`scripts/shorts-pc-worker.py` (Python 3, standard library only) uploads a folder of GPU renders (`shot-1.png`,
`shot-1.mp4`, `sfx-1.wav`, `voice.wav`) to a run and, if `faster-whisper` is installed, sends word timings for
`voice.wav`. Then it resumes the run (`--from` / `--until` pass through). See the script header.

```
set FRAYMUS_URL=https://fraymus-fly-io.fly.dev
set FRAYMUS_TOKEN_FILE=C:\Users\you\workspace-access-token.txt     (or FRAYMUS_TOKEN; never printed)
python scripts\shorts-pc-worker.py sht_xxxxxxxxxxxx C:\renders\pigwar [--from images] [--until images]
```

### VoiceStudio voice (your own cloned voice, on the PC GPU)

[VoiceStudio](https://github.com/debpalash/VoiceStudio) (free, local; v0.5.7 tested on an RTX 3070) runs its API at
`http://127.0.0.1:3900`; local requests need no key. With `--voice voicestudio` the worker:

1. reads the run's shot lines from Fly (plans the run first if it has no plan yet),
2. voices each line with `POST /generate` (`text`, `profile_id`) using the chosen VoiceStudio profile,
3. joins the lines into one `voice.wav` (0.15 s lead, 0.3 s between lines) and writes `voice-timings.json`,
4. uploads `voice.wav` (`/assets/voice/0`) and the word timings (`/timings`), then resumes the run from `voice`.

The server's voice stage then uses that take instead of Piper (`voice.engine = "upload"`, `timingSource = "upload"`),
and still checks the timings word for word against the narration.

```
python scripts\shorts-pc-worker.py sht_xxxxxxxxxxxx C:\renders\pigwar --voice voicestudio
python scripts\shorts-pc-worker.py sht_xxxxxxxxxxxx C:\renders\pigwar --voice voicestudio --cast-voices villain=overlord --shot-voices 7=overlord
python scripts\shorts-pc-worker.py - C:\renders\test --voice voicestudio --dry-run --text "One line to try."   (no Fly calls)
```

| Setting (flag / env) | Default | Meaning |
|---|---|---|
| `--voice voicestudio` / `SHORTS_VOICE` | off | turn the VoiceStudio voice on |
| `--voicestudio-url` / `VOICESTUDIO_URL` | `http://127.0.0.1:3900` | VoiceStudio backend |
| `--profile` / `VOICESTUDIO_PROFILE` | `vaughn-one` | narrator voice (profile name or id from `GET /profiles`) |
| `--cast-voices` / `VOICESTUDIO_CAST` | – | `cast=profile,...`; a shot whose cast (id, name or role) matches uses that voice |
| `--shot-voices` / `VOICESTUDIO_SHOTS` | – | `shot=profile,...`; per-shot override |
| `VOICESTUDIO_GAP` | `0.3` | seconds of pause between lines |
| `VOICESTUDIO_MAX_WER` / `--accept-voice` | `0.25` | a line Whisper hears this differently from the script is re-taken once, then the upload stops (unless `--accept-voice`) |
| `VOICESTUDIO_TIMEOUT` | `300` | seconds per line |

Word timings, best first: VoiceStudio's own Whisper (`/v1/audio/transcriptions`, needs its speech-to-text model —
download *Whisper large-v3* in VoiceStudio's Model Catalogue), local `faster-whisper` (`pip install faster-whisper`,
`WHISPER_MODEL`), else an even split of each line's words inside the part of the line where there is sound. Because
every line is voiced separately, each shot's first-word time (and so each cut) is exact even in the even-split case;
only the word-by-word caption timing within a line is approximate. Whisper's words are mapped back onto the script's
words, so number formatting ("12" for "twelve") doesn't fail the server's word-for-word check.

**Fallback:** if VoiceStudio can't be reached, the profile doesn't exist, or a line fails, no voice is uploaded and
the server voices the run with Piper as before (the other assets still upload).

**Voices:** only use profiles that are your own voice, a designed (synthetic) voice, or a person who agreed to be
cloned. Don't clone celebrities, actors or famous characters (e.g. a film villain's voice): design a similar-sounding
original voice instead.

## Fly

The Dockerfile installs `ffmpeg espeak-ng fonts-dejavu-core` (~+150 MB image). One render at a time
(`SHORTS_MAX_CONCURRENT=1`, `SHORTS_FFMPEG_THREADS=2`); a 1080×1920 render peaks under ~1 GB for ffmpeg.
Optional: `PIPER_BIN` + `PIPER_MODEL` (a free Piper voice on the /data volume) for a more natural voice.
