# FRAYMUS Local API v0.2

Runs on `http://127.0.0.1:8765`. All API responses are JSON unless noted. Optional `FRAYMUS_SERVER_TOKEN` protects API routes with `Authorization: Bearer <token>`; the static dashboard is served without authentication.

Every route checks that `Host` is this server, and that `Origin`, when present, matches it. POST bodies must be `application/json`. These checks block DNS rebinding and cross-site requests from web pages you visit.

## `GET /api/config`
Returns provider slots, limits and these derived fields: `mode` (`demo`, `local` or `remote`), `source` (`file`, `ollama` or `demo`), `active_run`, and per-slot `remote` and `key_present`. It shows the *name* of each key variable, never its value.

With no `config/providers.json`, the server builds a default: installed Ollama models across the eight roles, or demo fixtures if Ollama is unreachable.

## `POST /api/config`
Validates and saves the configuration to `config/providers.json`. Returns the saved config, or 400 with the reason. Returns 409 while a run is active.

## `GET /api/ollama/models`
Returns `{"models": [...]}`: installed Ollama models plus known Ollama Cloud names.

## `GET /api/connections`
Checks every provider and returns `id`, `name`, `access`, `ready` and `detail` (the next step when not ready). Takes a few seconds. Secrets are checked, never returned.

## `GET /api/recommended`
Returns a full config spreading the eight roles across ready providers. It saves nothing; POST it to `/api/config` to keep it.

## `POST /api/test-slot`

```json
{"slot": {"name": "Test", "kind": "ollama", "model": "MODEL"}, "approve_remote": false}
```

Sends one full-size stage and runs the reply through the real parser, so it can take a minute. Returns `{"ok": true, "seconds": 14.2, "items": 41}` or `{"ok": false, "error": "..."}`. A reply with no parsed findings is a failure. A remote slot needs `approve_remote: true`, because the call may be billed.

## `POST /api/run`

```json
{
  "request": "Create a dynamic simulated container",
  "approve_remote": false
}
```

Starts the chain in the background and returns **202** with `{"id": "..."}`. If any slot sends data off this machine, both `allow_remote: true` in config and `approve_remote: true` on the request are mandatory. Only one run may execute at a time (HTTP 409 otherwise). Stage failures do not stop the chain.

```bash
curl -s -X POST http://127.0.0.1:8765/api/run \
 -H 'Content-Type: application/json' \
 -d '{"request":"Define a deterministic simulation architecture"}'
```

## `GET /api/runs/{id}/events`
A server-sent event stream. Each `data:` frame is the full run JSON. The stream ends after the final state. For a finished run it sends one frame.

## `POST /api/runs/{id}/cancel`
Requests cancellation and returns 202. The run stops at once. A model call already in flight is abandoned, though a provider may still finish it and bill it. Returns 409 if that run is not active.

A run's JSON includes `usage`, with calls and tokens under `all`, `phases` and `providers`. Each provider also has `billing`: `per_token`, `credits`, `plan`, `local` or `none`. Each also has `usd`, a list-price estimate, and `unpriced_calls`. Older runs have no `usage`. A run stopped by a limit has status `budget_exceeded` and a `stop_reason`.

### POST /api/runs/{id}/resume
Continues an interrupted or capped run under its own id and returns **202** with `{"id": "..."}`. Finished stages and real stage failures are kept, and the stage that was cut off runs again. A finished review or brief is not repeated. It uses current provider settings and needs the same `approve_remote: true` as a new run. Returns 404 for an unknown run, and 409 if the run can't be resumed or another job is running.

## `GET /api/runs`
Returns the 100 newest run summaries, newest first.

## `GET /api/runs/{id}`
Returns a saved run. IDs are 16 lowercase hex characters. Contains the original request, raw model responses and errors; handle as confidential data.

## `GET /api/runs/{id}/document`
Returns the readable result as `text/markdown`: the brief if one was written, followed by the sourced ledger.

## `DELETE /api/runs/{id}`
Permanently deletes a saved run. Returns 409 if it is active.

## `POST /api/export/{id}`
No body needed. Writes the package `skills/candidate-{id}/` (`skill.json`, `CONTRACT.md`, `tests/test_acceptance.py`) and `skills/candidate-{id}.json`, and returns the manifest with `package`, its folder. Its status is `candidate_unverified`. It is **not** executable software, and no source code is generated or run. Returns 400 for a run still in progress or one with an empty ledger.

## `GET /api/runs/{id}/verify`
Checks the run's signed chain (see [SIGNING.md](SIGNING.md)) and returns `{ok, run, signer, public, records, head, mode, errors, warnings}`. `mode` is `mock`, `mixed`, `real` or `none`.

## Run status values
`running`, `complete`, `partial_failure` (some stages failed), `failed` (no stage succeeded), `cancelled`, `budget_exceeded`, `interrupted` (the server stopped mid-run).

## Errors
Bad request 400, unauthorized 401, foreign Host or Origin or unapproved remote provider 403, not found 404, conflict 409, wrong content type 415, unhandled error 500. Individual provider failures are recorded in the run, not as HTTP errors.

## Benchmark

`GET /api/benchmark` returns `{running, error, report}`. `report` is the live report during a run, otherwise the latest saved one, or `null`.

`POST /api/benchmark` starts a run and returns `202 {id}`. With remote providers it needs `allow_remote` in config and `{"approve_remote": true}` in the body, or it returns `403`. It returns `409` while a chain or another benchmark is running.

`POST /api/benchmark/cancel` stops the run, saves nothing, and returns `202`, or `409` if none is running.

## Quality test

`GET /api/quality` returns `{running, error, report, criteria, current_hash}`. `criteria` maps item ids to their text, and a report whose `cases_hash` differs from `current_hash` used an older test. Each scored run carries `claims`, with counts, the untraced claims, `new_terms`, and how many planted fakes were tested and caught.

`POST /api/quality` starts a test and returns `202 {id}`. With remote providers it needs `allow_remote` in config and `{"approve_remote": true}`. It returns `409` while another job runs.

`POST /api/quality/cancel` stops the test, saves nothing, and returns `202`, or `409` if none is running.
