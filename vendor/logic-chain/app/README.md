# app

The Python server and the interface. It uses only the standard library, with no build step. Back to the [README](../README.md).

| File | Job |
| --- | --- |
| `engine.py` | The 16 stages, parsing, ledger merge, prompts, the brief, saved runs, resume |
| `jev.py` | Review votes, batching, seats and grouped decisions |
| `usage.py` | Calls, tokens, estimated cost and caps per run |
| `prices.json` | List prices used for estimates and caps. Check the date inside |
| `benchmark.py` | Known-answer scoring and review seats |
| `known_answers.json` | The 48 benchmark cases. Editing them clears all calibration |
| `quality.py` | Plan scoring against checklists, with tested judges |
| `quality_cases.json` | The checklists and control documents. Editing them marks older scores as not comparable |
| `claims.py` | Traces each brief claim to the ledger, with planted fakes |
| `claim_cases.json` | Control claims and planted fakes for tracing |
| `providers.py` | Provider adapters, membership CLIs, connection checks, demo fixture |
| `settings.py` | Provider settings: detection, recommended mix, `.env`, validation |
| `server.py` | Local web server, JSON API, live event stream, consent gate |
| `fraymus.py` | Ed25519 (RFC 8032), fx numbers, the local identity and signed chain records |
| `verify.py` | Checks a run's or skill package's signatures, links and ledger replay; `python3 run.py verify` |
| `index.html`, `style.css`, `app.js` | The interface |

See [ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the design and [API.md](../docs/API.md) for the routes.
