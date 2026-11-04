# FRAYMUS / Nodular Workspace

One self-contained app (Fastify API + React UI + SQLite) that you can run **on Fly.io, on your own VPS, or on any PC with Docker or Node**. Nothing in the code needs Fly: Fly is just one place it runs.

What is in it:

- **Nodular workflow canvas**: chain LLM prompt -> FLUX image -> background remover -> upscaler -> preview, and deploy a workflow as an API (`POST /api/workflows/:id/run`). Works with no keys (mocks + local sharp).
- **Shopify credit fulfillment + buyer page** (`/enhance`): Shopify order webhook adds credits, buyers sign in with an emailed one-time code (Resend) and run the paid pipeline.
- **Agents** (`agents/*.md`) with tools, approvals, memory, an MCP server/hub and a cron scheduler.
- **Library**: every image, clip, chat, memory and pipeline stage is saved and browsable (`/api/library`, Library tab, export).
- **FRAYMUS Logic Chain**: eight model seats over two passes produce an Ed25519-signed audit chain, a brief and a candidate skill package. It runs as a loopback Python sidecar, is MOCK by default with spending caps on live runs, and saves to the Library. See [docs/LOGIC-CHAIN.md](docs/LOGIC-CHAIN.md).
- **Story Shorts**: an offline pipeline that turns a narration into a vertical cartoon short (FFmpeg + sharp + Piper voice), with an optional PC worker that adds GPU pictures/clips and your own **VoiceStudio** voice.

## Run it

### A. Docker (recommended, same image as Fly)

    cp .env.example .env        # fill in only what you need; everything is optional
    docker compose up -d --build
    curl http://localhost:3001/health

The image includes ffmpeg, espeak-ng, Piper and the public-domain `en_US-ljspeech-medium` voice. Data (SQLite DBs, outputs, Library, shorts runs) is kept in the `nodular-data` volume at `/data`. On a VPS set `HOST_BIND=127.0.0.1` in `.env` and put a reverse proxy (Caddy/nginx) or Tailscale in front, or change `HOST_PORT`.

### B. Node directly

Prerequisites: Node 22.5+ (24 recommended, uses built-in `node:sqlite`), npm, Python 3.10+ for the Logic Chain sidecar, and for Story Shorts `ffmpeg` + `espeak-ng` on PATH. Optional: Piper (`PIPER_BIN`, `PIPER_MODEL` = a `.onnx` with its `.onnx.json`) for the natural voice; without it the voice stage uses espeak-ng.

    npm install --legacy-peer-deps
    cp .env.example .env
    npm start                   # builds the UI, then serves UI + API on http://localhost:3001

Development with hot reload: `npm run dev:all` (UI :5173, API :3001). Data goes to `DATA_DIR` (default `./data`).

### C. Fly.io (the live app `fraymus-fly-io`)

`fly.toml` + `Dockerfile` in the repo root; one 2 GB machine, volume `nodular_data` at `/data`. Secrets are set with `fly secrets set` and never committed. See [FLY.md](FLY.md) and [DEPLOY.md](DEPLOY.md).

### Sign-in

`/api/*` fails closed. Either set `CLERK_SECRET_KEY` (+ `VITE_CLERK_PUBLISHABLE_KEY` at build time) for Clerk, or set `WORKSPACE_ACCESS_TOKEN` and sign in once at `/login` (or send `Authorization: Bearer <token>`). `WORKSPACE_AUTH=off` is for local dev only.

## Configuration

All settings are environment variables; [.env.example](.env.example) lists every one with a comment (names only, no values). The main groups:

| Group | Variables |
|---|---|
| Server | `PORT` (3001), `HOST` (0.0.0.0), `DATA_DIR` (`./data`, `/data` in Docker/Fly), `PUBLIC_URL`, `CORS_ORIGIN`; compose: `HOST_PORT`, `HOST_BIND` |
| Auth | `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `WORKSPACE_ACCESS_TOKEN`, `WORKSPACE_AUTH`, `OWNER_USER_IDS`, `MCP_ADMIN_TOKEN` |
| LLMs | `LLM_PROVIDERS`, `OLLAMA_*`, `GROQ_*`, `OPENAI_BASE_URL/API_KEY/MODEL`, `PROMPT_LLM*`, `EMBED_*` |
| Images | `HF_TOKEN`, `HF_FLUX_*`, `REPLICATE_API_TOKEN`, `REQUIRE_AI_UPSCALE` |
| Shopify / buyers | `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_PACK_PRODUCT_ID`, `SHOPIFY_CREDITS_PER_PACK`, `RESEND_API_KEY`, `MAIL_FROM`, `BUYER_PIPELINE_STRICT`, `FREE_CREDITS` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_METER_EVENT_NAME` |
| Story Shorts | `PIPER_BIN`, `PIPER_MODEL`, `PIPER_LENGTH_SCALE`, `PIPER_SENTENCE_SILENCE`, `ESPEAK_*`, `FFMPEG_BIN`, `FFPROBE_BIN`, `SHORTS_MAX_CONCURRENT`, `SHORTS_FFMPEG_THREADS` |
| Logic Chain | `LOGIC_CHAIN`, `LOGIC_CHAIN_PROVIDERS`, `XAI_API_KEY`, `GEMINI_API_KEY` (+ `OPENAI_*`, `PROMPT_LLM_API_KEY` for xAI), `LOGIC_CHAIN_*_MODEL`, `LOGIC_CHAIN_MAX_RUN_CENTS`, `LOGIC_CHAIN_MAX_PLAN_CALLS`, `LOGIC_CHAIN_MAX_SECONDS`, `FRAYMUS_IDENTITY_FILE`, `FRAYMUS_IDENTITY_SEED`, `LOGIC_CHAIN_PYTHON/DIR/PORT/URL` |
| Media/MCP | `VOICESTUDIO_MCP_URL`, `PHOTOCRAFT_CLI`, `REA_MCP`, `MCP_SERVERS_FILE`, `ALLOW_STDIO_IMPORT`, `AGENTS_DIR`, `SCHEDULER` |

Optional Supabase store instead of SQLite: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (Shopify credits need SQLite).

## Health and tests

- `GET /health` -> `{ ok, store, workspaceAuth, clerk, accessToken }`; `GET /api/shorts/status` shows which media tools were found (ffmpeg, espeak, piper).
- `npm test` boots a throwaway server and runs the e2e suites; `npm run test:shorts`, `npm run test:library`, `npm run test:shopify`, etc. `make help` lists shortcuts.

## Library

Everything the app makes is saved as a Library item (types: image, media, chat, evolve, fossil, pattern, memory, akashic, canvas, buyer, pipeline, logic) with tags, thumbnails and files: `GET /api/library`, `/api/library/items/:id[/file|/thumb]`, `/api/library/export`. Story Shorts stages show up as `pipeline` items; Logic Chain briefs, signed `run.json` and skill packages as `logic` items.

## Agents

Open the **Agents** tab: chat with Concierge or any of the specialists defined in `agents/*.md`.
Tools run automatically when safe; risky ones (`http_get`, `run_workflow`, HTTP tools) show an **Approve / Reject** card.

- **Models**: `LLM_PROVIDERS` order (Ollama -> Groq -> OpenAI-compatible). Point `OLLAMA_HOST` at your VPS. With nothing configured, a clearly labeled offline mock answers (a banner is shown).
- **Edit agents**: each agent is one manifest file, `agents/<id>.md` (front-matter: id, name, role, description, greeting, model, tools; body = system prompt). Edit the file, use the **Connect** tab, or let a connected agent do it over MCP; runtime edits are stored as overrides in `DATA_DIR/agents/` and win over the shipped defaults. Users can also create their own agents via `POST /api/agents`.
- **HTTP tools**: `config/http-tools.json` defines tools backed by your own services (Fraynix engine, Hermes, TTS). **These endpoint paths and body shapes are templates I guessed; adapt them to your real APIs.** A tool is skipped until every `${ENV:NAME}` it references is set.
- **Data**: threads, memories and approvals live in `DATA_DIR/agent.db` (local SQLite).
- **Safety**: `http_get` blocks private/loopback addresses (SSRF) unless `ALLOW_PRIVATE_FETCH=1`; delegated agents cannot run approval tools.
- **Tests**: `node scripts/test-agent.mjs` (server with `LLM_PROVIDERS=none`).

## Media skills (MCP bridge + HyperFrames)

`config/mcp-servers.json` lists MCP servers whose tools are registered as `<server>__<tool>` (approval required unless in `safeTools`). A server is skipped unless its env var is set; status is in `/api/agent/status` under `mcp`.

| Skill | How it is wired | Status |
|---|---|---|
| HyperFrames (Apache-2.0) | native `hyperframes_render` tool: HTML composition -> MP4/WebM/GIF via `npx hyperframes` (needs Node 22+, Chrome, FFmpeg) | **tested**: real 1080x1920 H.264 render |
| VoiceStudio (AGPL-3.0) | MCP over HTTP, set `VOICESTUDIO_MCP_URL`. Install per https://voicestudio.sh | bridge tested with a fake MCP server; real VoiceStudio untested |
| PhotoCraft (Apache-2.0) | stdio MCP, set `PHOTOCRAFT_CLI` to the `photocraft-cli` binary | bridge tested; real binary untested |
| REA = *Reverse Engineer Anything* (MIT) | stdio MCP via `npx rea-agents --mcp`, set `REA_MCP=1` | bridge tested; real server untested. This is NOT the realtime editing agent |
| Hypit | **not integrated**: it is a skill for coding agents (Claude Code/Codex) with its own license, not a runnable node | - |
| Yjs realtime co-editing | **not built** | - |

The `video_director` agent writes and renders HyperFrames compositions. Tests: `npx tsx scripts/test-mcp.ts`, `npx tsx scripts/test-media.ts`.

## Self-hosted agent hub: MCP server, MCP import, OAuth in

Everything Base44 did for agents now runs here, free and self-hosted. Other agents (OpenClaw, Claude, anything that speaks MCP) can join, see and change it.

- **MCP server**: `POST /mcp` (streamable HTTP, stateless, `Authorization: Bearer <token>`). Tools: `list_agents`, `get_agent`, `upsert_agent`, `reset_agent`, `list_tools`, `run_agent`, `list_threads`, `get_thread`, `decide_approval`, `call_tool`, `list_mcp_servers`, `import_mcp_server`, `remove_mcp_server`. Runs started over MCP show up in the Agents tab like any other conversation.
- **Scopes**: `read` (inspect), `run` (talk to agents), `admin` (edit agents, call any tool, approve, import MCP servers). Admin means full autonomy: only give it to agents you trust.
- **OAuth in**: create a client in the **Connect** tab, then `POST /oauth/token` with `grant_type=client_credentials` (client_secret_basic or _post) for a 1-hour bearer token. Discovery: `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. Long-lived access tokens can be minted in the same tab. Headless setup: set `MCP_ADMIN_TOKEN` (24+ chars) in `.env`. *Not implemented*: the interactive authorization-code + PKCE flow some hosted MCP clients expect; use client_credentials or a token.
- **MCP import**: Connect tab or `import_mcp_server`; accepts one server or a Claude-Desktop-style `mcpServers` block. HTTP servers are always allowed; local-command servers need `ALLOW_STDIO_IMPORT=1`. Imported servers persist in `DATA_DIR/mcp-servers.json` (may contain headers/secrets; file mode 600 on POSIX).
- **Security**: `/mcp` always requires a token, but the token-minting API under `/api` is open when `CLERK_SECRET_KEY` is unset. Put the server behind Tailscale/a firewall or enable Clerk before exposing it.
- **Tasks**: `make help` (or the matching `npm` scripts). `npm test` boots a throwaway server and runs all e2e suites. `make` itself was not run on this Windows machine.
## Automations (scheduler)

Cron-scheduled (5-field, **UTC**) agent runs or tool calls, replacing Base44 scheduled automations. Manage via `/api/automations` or the MCP tools `list_automations`, `upsert_automation` (admin), `run_automation`, `automation_runs`, `delete_automation`. Templates (`daily-report`, `six-hour-research`, `heartbeat`) install disabled. Unattended agent runs never auto-approve risky tools; they end as `awaiting_approval`. Tool automations call the tool directly (admin-created only). Set `SCHEDULER=off` to disable the ticker. Not ported: LinkedIn, Google Calendar and Base44-entity triggers (no native equivalent), and data-change triggers (use `POST /api/automations/:id/trigger` from a webhook).

## FRAYMUS Logic Chain

[FRAYMUS-Logic-Chain](https://github.com/eyeoverthink/FRAYMUS-Logic-Chain) is vendored at a pinned commit in `vendor/logic-chain` (see `UPSTREAM.md`; update it with `scripts/sync-logic-chain.sh <sha>`). The app runs it as a supervised child process on `127.0.0.1` inside the same container, so it needs no extra service, port or Fly process. Full details: [docs/LOGIC-CHAIN.md](docs/LOGIC-CHAIN.md).

- **API**: `POST /api/logic-chain/runs` `{objective}` → `202`. Then `GET /api/logic-chain/runs/:id` (status, label, brief, Library links, `?full=1` = signed `run.json`), `GET .../verify`, `GET .../document`, `POST .../cancel`, `GET /api/logic-chain/status`, `GET /api/logic-chain/skills`, and `POST /api/logic-chain/skills/:id/agents`.
- **Mock vs live**: runs are **MOCK** (demo fixtures, no network, $0, labelled MOCK everywhere) unless the owner sends `mode: "live"` with `approveSpend: true`. Live runs use server-side keys only (`XAI_API_KEY` or the x.ai `PROMPT_LLM_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`). They are capped at $1.00 and 60 calls by default. A run is labelled LIVE only if every stage used a real model.
- **Signing**: `FRAYMUS_IDENTITY_FILE` or the `FRAYMUS_IDENTITY_SEED` secret. If neither is set, a clearly labelled **LOCAL KEY** is used.
- **Library + skills**: each run saves a brief, the signed `run.json` and its skill package (type `logic`). Skill packages are registered for **no** agent until you select agents. They are specifications, never executed.
- **Agent tools**: `logic_chain_run` (approval), plus `logic_chain_status`, `logic_chain_verify` and `logic_chain_skills` (safe).
- **Standalone**: `cd vendor/logic-chain && docker compose up --build` → http://127.0.0.1:8765.
- Test: `npm run test:logic-chain`.

## Story Shorts (offline pipeline)

Vertical cartoon story shorts from a narration, made from free offline tools only: plan -> voice -> pictures -> clips -> sound -> captions/edit -> QA. Each stage is checked before the next and saved to the Library (`pipeline`). Full stage table and API: [docs/STORY-SHORTS.md](docs/STORY-SHORTS.md).

- **Voice**: Piper `en_US-ljspeech-medium` (MIT engine, public-domain training data, OK for commercial use) -> espeak-ng -> silent guide. Swap voices with `PIPER_MODEL`.
- **API**: `/api/shorts/status`, `/api/shorts/plan`, `/api/shorts/runs` (create/list), `/api/shorts/runs/:id/run`, asset uploads `/api/shorts/runs/:id/assets/:kind/:n`, `/api/shorts/runs/:id/timings`, `/api/shorts/study`.
- **Agent tools**: `shorts_plan` (check a narration and plan shots) and `shorts_make` (create and run a short).
- Test: `npm run test:shorts`.

### PC worker + VoiceStudio (your own voice)

`scripts/shorts-pc-worker.py` (Python 3, stdlib only; `faster-whisper` optional) runs on your PC, never on the server. It uploads GPU renders (`shot-<n>.png`, `shot-<n>.mp4`, `sfx-<n>.wav`, `voice.wav`) to a run and resumes it. Point it at any install of this app:

    set FRAYMUS_URL=http://localhost:3001          (or https://fraymus-fly-io.fly.dev, or your VPS)
    set FRAYMUS_TOKEN_FILE=C:\path\token.txt       (file holding the workspace token; never printed)
    python scripts\shorts-pc-worker.py sht_xxxxxxxxxxxx C:\renders\myshort --voice voicestudio --profile vaughn-one --cast-voices villain=overlord

With `--voice voicestudio` it voices each shot line through [VoiceStudio](https://github.com/debpalash/VoiceStudio) (AGPL, local GPU app, API at `VOICESTUDIO_URL`, default `http://127.0.0.1:3900`), builds word timings (VoiceStudio Whisper, else faster-whisper, else an even split per line), and uploads both so the server uses that take instead of Piper. If VoiceStudio is not reachable it uploads nothing and the server falls back to Piper. `--dry-run --text "..."` tries a voice without sending anything.

**Voices: only clone your own voice, use a designed (synthetic) voice, or a person who agreed to be cloned. Never a celebrity's or an actor's voice.**

