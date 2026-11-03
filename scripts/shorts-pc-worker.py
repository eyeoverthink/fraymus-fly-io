#!/usr/bin/env python3
"""Story Shorts PC helper (optional; runs on the PC/Pi with a GPU, never on Fly).

Uploads per-shot renders made locally (Stable Diffusion/ComfyUI pictures, Wan/LTX clips, a voice take) to a run on
the Fly app and, if faster-whisper is installed (pip install faster-whisper), sends word timings for the voice so cuts
and captions are exact. Then resumes the run.

  set FRAYMUS_URL=https://fraymus-fly-io.fly.dev
  set FRAYMUS_TOKEN=<workspace access token>        (or FRAYMUS_TOKEN_FILE=<path to a file holding it>; never printed)
  python scripts/shorts-pc-worker.py sht_xxxxxxxxxxxx C:\\renders\\pigwar [--from images] [--until images]

Folder layout: shot-<n>.png, shot-<n>.mp4, sfx-<n>.wav, voice.wav (any subset).

VoiceStudio voice (local voice clone / designed voice, https://github.com/debpalash/VoiceStudio, runs on the PC GPU):

  python scripts/shorts-pc-worker.py sht_xxxxxxxxxxxx C:\\renders\\pigwar --voice voicestudio
      [--profile vaughn-one] [--cast-voices villain=overlord,pig=vaughn-one] [--shot-voices 7=overlord]
  python scripts/shorts-pc-worker.py - C:\\renders\\test --voice voicestudio --dry-run --text "One line to try."

  Reads the run's shot lines from Fly, voices each line with VoiceStudio (POST /generate, text + profile_id), joins
  them into voice.wav and writes voice-timings.json (word timings), then uploads both so the server's voice stage uses
  this take instead of Piper. Word timings come from VoiceStudio's own Whisper (/v1/audio/transcriptions) when it has
  a speech-to-text model, else local faster-whisper, else an even split of each line inside its spoken part (the cut
  for each shot still lands exactly, because every line's start is known).
  If VoiceStudio can't be reached or fails, no voice is uploaded and the server voices the run with Piper as before.
  --dry-run: make voice.wav + voice-timings.json only; nothing is sent to Fly (the run's lines are read if a run id
  and token are given, else --text / --text-file is used).

  Settings (flags win over env): VOICESTUDIO_URL (http://127.0.0.1:3900), VOICESTUDIO_PROFILE (vaughn-one, the
  narrator), VOICESTUDIO_CAST ("villain=overlord,..." matched against a shot's cast id/name/role), VOICESTUDIO_GAP
  (pause between lines, 0.3 s), VOICESTUDIO_TIMEOUT (300 s per line), VOICESTUDIO_MAX_WER (0.25: a line Whisper
  hears this differently from the script is re-taken once, then the upload stops), WHISPER_MODEL (small.en).
  Only use voice profiles that are your own voice, a designed (synthetic) voice, or a person who agreed to be cloned:
  never a celebrity's or a character actor's voice.

Every Fly request times out after FRAYMUS_TIMEOUT seconds (default 120) and is retried up to 2 more times on network
errors, so a stalled connection can't hang the worker.
"""
import array, difflib, hashlib, io, json, os, re, shutil, socket, subprocess, sys, tempfile, time, unicodedata
import urllib.error, urllib.request, uuid, wave

TIMEOUT = float(os.environ.get("FRAYMUS_TIMEOUT", "120"))

def token():
    t = os.environ.get("FRAYMUS_TOKEN")
    if not t and os.environ.get("FRAYMUS_TOKEN_FILE"):
        with open(os.environ["FRAYMUS_TOKEN_FILE"], encoding="utf-8-sig") as f: t = f.read().strip()
    if not t: raise SystemExit("set FRAYMUS_TOKEN (or FRAYMUS_TOKEN_FILE) to the workspace access token")
    return t

def multipart(fields):
    """fields: {name: str | (filename, bytes, content_type)} -> (body, content_type)"""
    b = uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        if isinstance(v, tuple):
            fn, blob, ct = v
            out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n".encode() + blob + b"\r\n"
        else:
            out += f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    return out + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}"

def call(method, path, body=None, files=None):
    url = os.environ.get("FRAYMUS_URL", "https://fraymus-fly-io.fly.dev").rstrip("/") + path
    headers = {"Authorization": "Bearer " + token()}
    data = None
    if files:
        name, blob = files
        data, headers["Content-Type"] = multipart({"file": (name, blob, "application/octet-stream")})
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

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): h.update(chunk)
    return h.hexdigest()

# ---------- words (same rules as server/shorts/plan.ts) ----------
def words(s): return str(s or "").split()
def norm(w):
    w = unicodedata.normalize("NFKC", w.lower()).replace("\u2019", "'")
    return "".join(ch for ch in w if ch.isalnum() or ch in "$'")

def sentences(story):
    toks, out, cur = " ".join(words(story)).split(" "), [], ""
    if toks == [""]: return []
    for i, t in enumerate(toks):
        cur += (" " if cur else "") + t
        abbrev = re.match(r"^(Mr|Mrs|Ms|Dr|St|Sir|Jr|Sr|vs|etc|U\.S|U\.K)\.$", t, re.I)
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if re.search(r"[.!?\u2026][\"')\]]*$", t) and not abbrev and (nxt is None or re.match(r"^[\"'(\[]?[A-Z\d$]", nxt)): out.append(cur); cur = ""
    if cur: out.append(cur)
    return out

def weight(w): return max(2, len(norm(w))) + (6 if re.search(r"[.!?]$", w) else 3 if re.search(r"[,;:\u2014\u2013]$", w) else 0)

def even_split(text, start, end):
    """Spread a line's words over [start,end] by length + punctuation (like the server's estimateTimings)."""
    ws = words(text); total = sum(weight(w) for w in ws) or 1; span = max(0.05, end - start); t = start; out = []
    for w in ws:
        d = weight(w) / total * span
        pause = (6 if re.search(r"[.!?]$", w) else 3 if re.search(r"[,;:\u2014\u2013]$", w) else 0) / total * span
        out.append({"w": w, "start": round(t, 3), "end": round(t + max(0.02, d - pause), 3)}); t += d
    return out

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
def _num(n):
    if n < 20: return _ONES[n]
    if n < 100: return _TENS[n // 10] + (_ONES[n % 10] if n % 10 else "")
    if n < 1000: return _ONES[n // 100] + "hundred" + (_num(n % 100) if n % 100 else "")
    return _num(n // 1000) + "thousand" + (_num(n % 1000) if n % 1000 else "")
def spoken(w):
    """Loose form for comparing what Whisper heard with the script: digits as words, no apostrophes ("12"=="twelve")."""
    w = norm(w).replace("'", "")
    return re.sub(r"\d{1,6}", lambda m: _num(int(m.group())), w)

def align(script_text, heard, start, end):
    """Put the script's own words on the heard (Whisper) word times. Returns (words, edits): edits counts script words
    Whisper heard as something else (number formatting and contractions like "it is"/"it's" don't count)."""
    sw = words(script_text); a = [spoken(w) for w in sw]; b = [spoken(h["w"]) for h in heard]
    out = [None] * len(sw); edits = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1): out[i1 + k] = {"w": sw[i1 + k], "start": heard[j1 + k]["start"], "end": heard[j1 + k]["end"]}
            continue
        same = i2 > i1 and j2 > j1 and difflib.SequenceMatcher(None, "".join(a[i1:i2]), "".join(b[j1:j2])).ratio() >= 0.75
        if not same: edits += max(i2 - i1, j2 - j1)
        if tag == "replace":  # spread the script words over the time Whisper heard for this span
            out[i1:i2] = even_split(" ".join(sw[i1:i2]), heard[j1]["start"], max(heard[j1]["start"] + 0.05, heard[j2 - 1]["end"]))
    i = 0  # words Whisper missed entirely: split the gap between their known neighbours
    while i < len(out):
        if out[i] is not None: i += 1; continue
        j = i
        while j < len(out) and out[j] is None: j += 1
        lo = out[i - 1]["end"] if i else start; hi = out[j]["start"] if j < len(out) else end
        out[i:j] = even_split(" ".join(sw[i:j]), lo, max(lo + 0.05 * (j - i), hi)); i = j
    for k in range(1, len(out)):  # monotonic, non-overlapping
        if out[k]["start"] < out[k - 1]["end"]: out[k]["start"] = out[k - 1]["end"]
        if out[k]["end"] < out[k]["start"]: out[k]["end"] = out[k]["start"]
    return out, edits

# ---------- wav helpers (stdlib only) ----------
def wav_info(blob):
    with wave.open(io.BytesIO(blob)) as w: return (w.getnchannels(), w.getsampwidth(), w.getframerate()), w.readframes(w.getnframes())

def to_params(blob, params):
    """Convert a wav to (channels, width, rate) with ffmpeg if the formats differ."""
    p, frames = wav_info(blob)
    if p == params: return frames
    ff = shutil.which("ffmpeg")
    if not ff: raise RuntimeError(f"VoiceStudio returned mixed wav formats {p} vs {params} and ffmpeg isn't on PATH")
    fmt = {1: "u8", 2: "s16le", 4: "s32le"}[params[1]]
    r = subprocess.run([ff, "-v", "error", "-i", "pipe:0", "-f", fmt, "-ac", str(params[0]), "-ar", str(params[2]), "pipe:1"], input=blob, capture_output=True, timeout=120)
    if r.returncode: raise RuntimeError("ffmpeg resample failed: " + r.stderr.decode(errors="replace")[-200:])
    return r.stdout

def speech_bounds(frames, params, thresh=0.02):
    """Seconds where speech starts/ends in a take (frame RMS over ~2% of full scale), for the even-split fallback."""
    ch, width, rate = params
    if width != 2 or not frames: return 0.0, len(frames) / (ch * width * rate)
    s = array.array("h"); s.frombytes(frames[: len(frames) // 2 * 2])
    if sys.byteorder == "big": s.byteswap()
    hop = max(1, int(rate * ch * 0.02)); lim = (thresh * 32768) ** 2
    loud = [i for i in range(0, len(s), hop) if sum(x * x for x in s[i:i + hop:4]) / max(1, len(s[i:i + hop:4])) > lim]
    total = len(s) / (ch * rate)
    if not loud: return 0.0, total
    return max(0.0, loud[0] / (ch * rate) - 0.02), min(total, (loud[-1] + hop) / (ch * rate) + 0.02)

# ---------- VoiceStudio ----------
class VoiceStudio:
    def __init__(self, url, timeout):
        self.url, self.timeout, self.asr = url.rstrip("/"), timeout, True
    def req(self, method, path, fields=None, timeout=None):
        data = ctype = None
        if fields: data, ctype = multipart(fields)
        r = urllib.request.Request(self.url + path, data=data, method=method, headers={"Content-Type": ctype} if ctype else {})
        with urllib.request.urlopen(r, timeout=timeout or self.timeout) as resp: return resp.read(), resp.headers.get("Content-Type", "")
    def health(self): return json.loads(self.req("GET", "/health", timeout=10)[0])
    def profiles(self): return json.loads(self.req("GET", "/profiles", timeout=20)[0])
    def speak(self, text, profile_id):
        blob, ct = self.req("POST", "/generate", {"text": text, "profile_id": profile_id})
        if not blob.startswith(b"RIFF"): raise RuntimeError(f"VoiceStudio /generate returned {ct or 'no content type'}, not a wav")
        return blob
    def transcribe(self, blob):
        """Word timings from VoiceStudio's own Whisper, or None when it has no speech-to-text model installed."""
        if not self.asr: return None
        try:
            raw, _ = self.req("POST", "/v1/audio/transcriptions", {"file": ("line.wav", blob, "audio/wav"), "model": "whisper-1", "response_format": "verbose_json", "timestamp_granularities[]": "word", "language": "en"})
        except urllib.error.HTTPError as e:
            msg = e.read()[:400].decode(errors="replace")
            print(f"  VoiceStudio transcription unavailable (HTTP {e.code}{': no speech-to-text model installed' if 'asr_model_missing' in msg else ''}); using the next timing source")
            self.asr = False; return None
        d = json.loads(raw); ws = d.get("words") or [w for s in d.get("segments") or [] for w in (s.get("words") or [])]
        out = [{"w": str(w.get("word", w.get("w", ""))).strip(), "start": float(w["start"]), "end": float(w["end"])} for w in ws if str(w.get("word", w.get("w", ""))).strip()]
        if not out: print("  VoiceStudio transcription returned no word timestamps; using the next timing source"); self.asr = False; return None
        return out

_fw = None
def faster_whisper_words(blob):
    global _fw
    if _fw is False: return None
    try:
        if _fw is None:
            from faster_whisper import WhisperModel
            _fw = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="auto")
    except Exception:
        _fw = False; return None
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f: f.write(blob); p = f.name
    try:
        segs, _ = _fw.transcribe(p, word_timestamps=True)
        return [{"w": w.word.strip(), "start": w.start, "end": w.end} for s in segs for w in s.words]
    finally: os.unlink(p)

def parse_map(s):
    out = {}
    for part in re.split(r"[,;]", s or ""):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip() and v.strip(): out[k.strip().lower()] = v.strip()
    return out

def resolve_profile(profiles, want):
    for p in profiles:
        if want == p.get("id") or want.lower() == str(p.get("name", "")).lower(): return p
    names = ", ".join(str(p.get("name")) for p in profiles)
    raise RuntimeError(f"VoiceStudio has no voice profile '{want}' (has: {names})")

def voice_lines(run, text):
    """[(n, text, cast_keys)] in narration order."""
    if run:
        shots = ((run.get("plan") or {}).get("shots")) or []
        cast = {c.get("id"): c for c in (run.get("input") or {}).get("cast") or []}
        if shots:
            return [(s["n"], s["text"], [k for cid in s.get("cast") or [] for k in (cid, (cast.get(cid) or {}).get("name"), (cast.get(cid) or {}).get("role")) if k]) for s in shots]
        text = (run.get("input") or {}).get("story") or ""
    return [(i + 1, t, []) for i, t in enumerate(sentences(text))]

def make_voicestudio_take(folder, lines, opts):
    """Voice every line with VoiceStudio -> folder/voice.wav + folder/voice-timings.json. Raises on any failure."""
    vs = VoiceStudio(opts["url"], opts["timeout"])
    h = vs.health()
    if h.get("status") != "ok": raise RuntimeError(f"VoiceStudio health: {h}")
    print(f"VoiceStudio {h.get('version', '?')} on {h.get('device', '?')}")
    profiles = vs.profiles()
    default = resolve_profile(profiles, opts["profile"])
    cast_map = {k: resolve_profile(profiles, v) for k, v in opts["cast"].items()}
    shot_map = {int(k): resolve_profile(profiles, v) for k, v in opts["shots"].items() if k.isdigit()}
    lead, gap, tail = 0.15, opts["gap"], 0.25
    params = None; pcm = bytearray(); timeline = 0.0; all_words = []; report = []
    def silence(sec): return b"\x00" * (int(sec * params[2]) * params[0] * params[1])
    for n, text, keys in lines:
        prof = shot_map.get(n) or next((cast_map[k.lower()] for k in keys if k.lower() in cast_map), None) or default
        best = None
        for attempt in range(2):
            t0 = time.time(); blob = vs.speak(text, prof["id"])
            if params is None:
                params = wav_info(blob)[0]; pcm += silence(lead); timeline = lead
            frames = to_params(blob, params); secs = len(frames) / (params[0] * params[1] * params[2])
            heard, src = vs.transcribe(blob), "voicestudio-whisper"
            if heard is None: heard, src = faster_whisper_words(blob), "faster-whisper"
            if heard is None:
                s0, s1 = speech_bounds(frames, params); ws, edits, src = even_split(text, s0, s1), 0, "even-split"
            else:
                ws, edits = align(text, heard, 0.0, secs)
            wer = edits / max(1, len(words(text)))
            cand = {"frames": frames, "secs": secs, "words": ws, "src": src, "wer": wer, "heard": " ".join(h["w"] for h in heard) if heard else None, "gen": time.time() - t0}
            if best is None or cand["wer"] < best["wer"]: best = cand
            if wer <= opts["max_wer"]: break
            print(f"  shot {n}: Whisper heard it differently from the script (WER {wer:.2f}); re-taking once")
        print(f"  shot {n}: {prof['name']} {best['secs']:.2f}s (made in {best['gen']:.1f}s), timings: {best['src']}" + (f", WER {best['wer']:.2f}" if best["heard"] is not None else ""))
        if best["wer"] > opts["max_wer"] and not opts["accept"]:
            raise SystemExit(f"shot {n} still doesn't match the script after a re-take (WER {best['wer']:.2f}; heard: {best['heard']!r}). Fix the line or pass --accept-voice.")
        all_words += [{"w": w["w"], "start": round(w["start"] + timeline, 3), "end": round(w["end"] + timeline, 3)} for w in best["words"]]
        pcm += best["frames"]; timeline += best["secs"]
        report.append({"n": n, "profile": prof["name"], "profile_id": prof["id"], "kind": prof.get("kind"), "seconds": round(best["secs"], 3), "timings": best["src"], "wer": round(best["wer"], 3), "heard": best["heard"]})
        if n != lines[-1][0]: pcm += silence(gap); timeline += gap
    pcm += silence(tail)
    out = os.path.join(folder, "voice.wav")
    with wave.open(out, "wb") as w: w.setnchannels(params[0]); w.setsampwidth(params[1]); w.setframerate(params[2]); w.writeframes(bytes(pcm))
    meta = {"engine": "voicestudio", "voicestudio": h.get("version"), "sha256": sha256(out), "seconds": round(len(pcm) / (params[0] * params[1] * params[2]), 3), "lines": report, "words": all_words}
    with open(os.path.join(folder, "voice-timings.json"), "w", encoding="utf-8") as f: json.dump(meta, f, indent=1)
    print(f"voice.wav {meta['seconds']}s, {len(all_words)} words -> voice-timings.json")
    return meta

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else default

def main():
    if len(sys.argv) < 3: print(__doc__); sys.exit(1)
    run_id, folder = sys.argv[1], sys.argv[2]
    run_id = None if run_id in ("-", "none") else run_id
    start = arg("--from")
    dry = "--dry-run" in sys.argv
    mode = (arg("--voice") or os.environ.get("SHORTS_VOICE", "")).lower()
    os.makedirs(folder, exist_ok=True)
    skip_voice = False
    if mode == "voicestudio":
        opts = {"url": arg("--voicestudio-url") or os.environ.get("VOICESTUDIO_URL", "http://127.0.0.1:3900"),
                "profile": arg("--profile") or os.environ.get("VOICESTUDIO_PROFILE", "vaughn-one"),
                "cast": parse_map(arg("--cast-voices") or os.environ.get("VOICESTUDIO_CAST", "")),
                "shots": parse_map(arg("--shot-voices") or os.environ.get("VOICESTUDIO_SHOTS", "")),
                "gap": float(os.environ.get("VOICESTUDIO_GAP", "0.3")), "timeout": float(os.environ.get("VOICESTUDIO_TIMEOUT", "300")),
                "max_wer": float(os.environ.get("VOICESTUDIO_MAX_WER", "0.25")), "accept": "--accept-voice" in sys.argv}
        text = arg("--text")
        if arg("--text-file"):
            with open(arg("--text-file"), encoding="utf-8-sig") as f: text = f.read()
        run = None
        if run_id and not text:
            run = call("GET", f"/api/shorts/runs/{run_id}")
            if not (run.get("plan") or {}).get("shots") and not dry:  # plan the shots first so each line gets its cast's voice
                call("POST", f"/api/shorts/runs/{run_id}/run?wait=1", {"until": "plan"}); run = call("GET", f"/api/shorts/runs/{run_id}")
        lines = voice_lines(run, text)
        if not lines: raise SystemExit("nothing to voice: give a run id with a story, or --text / --text-file")
        try:
            make_voicestudio_take(folder, lines, opts)
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, RuntimeError, OSError, ValueError, wave.Error) as e:
            print(f"VoiceStudio voice failed ({e}); no voice is uploaded, so the server voices this run with Piper")
            skip_voice = True
            if dry: sys.exit(2)
    if dry: print("dry run: nothing sent to Fly"); return
    if not run_id: raise SystemExit("a run id is needed to upload (or pass --dry-run)")
    kinds = {".png": "image", ".mp4": "clip", ".wav": "sfx"}
    for f in sorted(os.listdir(folder)):
        p = os.path.join(folder, f)
        if f.lower() in ("voice.wav", "voice.mp3"):
            if skip_voice: continue
            print(f, call("POST", f"/api/shorts/runs/{run_id}/assets/voice/0", files=(f, open(p, "rb").read())))
            tj = os.path.join(folder, "voice-timings.json")
            meta = json.load(open(tj, encoding="utf-8")) if os.path.exists(tj) else None
            if meta and meta.get("sha256") == sha256(p):  # timings made for exactly this take
                print("timings", call("POST", f"/api/shorts/runs/{run_id}/timings", {"words": meta["words"]}))
                continue
            try:
                from faster_whisper import WhisperModel
                model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="auto")
                segs, _ = model.transcribe(p, word_timestamps=True)
                words_ = [{"w": w.word.strip(), "start": w.start, "end": w.end} for s in segs for w in s.words]
                print("timings", call("POST", f"/api/shorts/runs/{run_id}/timings", {"words": words_}))
            except ImportError:
                print("faster-whisper not installed: timings will be estimated on the server")
            continue
        m = re.match(r"(shot|sfx)-(\d+)(\.\w+)$", f.lower())
        if not m: continue
        kind = "sfx" if m.group(1) == "sfx" else kinds.get(m.group(3))
        if kind: print(f, call("POST", f"/api/shorts/runs/{run_id}/assets/{kind}/{m.group(2)}", files=(f, open(p, "rb").read())))
    until = arg("--until")
    body = {k: v for k, v in (("from", start), ("until", until)) if v}
    print(call("POST", f"/api/shorts/runs/{run_id}/run", body))

if __name__ == "__main__":
    main()
