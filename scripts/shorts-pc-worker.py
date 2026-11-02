#!/usr/bin/env python3
"""Story Shorts PC helper (optional; runs on the PC/Pi with a GPU, never on Fly). UNTESTED against a live server.

Uploads per-shot renders made locally (Stable Diffusion/ComfyUI pictures, Wan/LTX clips, a voice take) to a run on
the Fly app and, if faster-whisper is installed (pip install faster-whisper), sends word timings for the voice so cuts
and captions are exact. Then resumes the run.

  set FRAYMUS_URL=https://fraymus-fly-io.fly.dev
  set FRAYMUS_TOKEN=<workspace access token>        (read from the environment; never printed)
  python scripts/shorts-pc-worker.py sht_xxxxxxxxxxxx C:\\renders\\pigwar [--from images]

Folder layout: shot-<n>.png, shot-<n>.mp4, sfx-<n>.wav, voice.wav (any subset).
Every request times out after FRAYMUS_TIMEOUT seconds (default 120) and is retried up to 2 more times on network
errors, so a stalled connection can't hang the worker.
"""
import json, os, re, socket, sys, time, urllib.error, urllib.request, uuid

TIMEOUT = float(os.environ.get("FRAYMUS_TIMEOUT", "120"))

def call(method, path, body=None, files=None):
    url = os.environ.get("FRAYMUS_URL", "https://fraymus-fly-io.fly.dev").rstrip("/") + path
    headers = {"Authorization": "Bearer " + os.environ["FRAYMUS_TOKEN"]}
    data = None
    if files:
        b = uuid.uuid4().hex
        name, blob = files
        data = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + blob + f"\r\n--{b}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={b}"
    elif body is not None:
        data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=TIMEOUT) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:  # the server answered: report it, don't retry
            raise SystemExit(f"{method} {path} -> HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            if attempt == 2: raise SystemExit(f"{method} {path} failed after 3 tries ({TIMEOUT:.0f}s timeout): {e}")
            time.sleep(2 * (attempt + 1))

def main():
    if len(sys.argv) < 3: print(__doc__); sys.exit(1)
    run, folder = sys.argv[1], sys.argv[2]
    start = sys.argv[sys.argv.index("--from") + 1] if "--from" in sys.argv else None
    kinds = {".png": "image", ".mp4": "clip", ".wav": "sfx"}
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.lower() in ("voice.wav", "voice.mp3"):
            print(f, call("POST", f"/api/shorts/runs/{run}/assets/voice/0", files=(f, open(p, "rb").read())))
            try:
                from faster_whisper import WhisperModel
                model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="auto")
                segs, _ = model.transcribe(p, word_timestamps=True)
                words = [{"w": w.word.strip(), "start": w.start, "end": w.end} for s in segs for w in s.words]
                print("timings", call("POST", f"/api/shorts/runs/{run}/timings", {"words": words}))
            except ImportError:
                print("faster-whisper not installed: timings will be estimated on the server")
            continue
        m = re.match(r"(shot|sfx)-(\d+)(\.\w+)$", f.lower())
        if not m: continue
        kind = "sfx" if m.group(1) == "sfx" else kinds.get(m.group(3))
        if kind: print(f, call("POST", f"/api/shorts/runs/{run}/assets/{kind}/{m.group(2)}", files=(f, open(p, "rb").read())))
    print(call("POST", f"/api/shorts/runs/{run}/run", {"from": start} if start else {}))

if __name__ == "__main__":
    main()
