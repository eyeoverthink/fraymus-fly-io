# FRAYMUS Logic Chain in this app

The [FRAYMUS Logic Chain](https://github.com/eyeoverthink/FRAYMUS-Logic-Chain) seats eight model roles (Architect,
Algorithm, Data Model, Implementation, Critic, Test Designer, Optimizer, Integrator) over two passes. Every stage is
sealed in an Ed25519-signed, hash-linked audit chain (`run.json`). The run ends with a brief and a **candidate skill
package**: a specification with a contract and acceptance-test scaffold, not executable code. This app runs it as a
first-class capability. You get an HTTP API, agent tools, Library items, and skill packages you can select per agent.

Code: `server/logic-chain/index.ts` (integration) and `vendor/logic-chain/` (the upstream code, unchanged).

## How it works

```
browser / agent / MCP ──► Fastify (/api/logic-chain/*, behind the workspace gate)
                              │  spawns + supervises, random per-boot Bearer token
                              ▼
                     python3 vendor/logic-chain/run.py  on 127.0.0.1:<free port>  (same container)
                              │  runs + identity in DATA_DIR/logic-chain (the /data volume on Fly)
                              ▼
          on completion: verify → export skill package → 3 Library items (type "logic") + record events
```

- **Sidecar, same container.** Node starts the vendored chain as a child process on loopback, with a random token
  for each boot. It restarts with backoff if it crashes. The chain's own Host check only accepts `127.0.0.1` and
  `localhost`, so a separate compose service, or a Fly `[processes]` group on another machine, would be refused. A
  separate machine also wouldn't share the `/data` volume or loopback with the single SQLite machine. The child reads
  its stdin and exits when Node goes away, so it can never be orphaned.
- **Vendored, pinned.** `vendor/logic-chain` is a plain copy (`git archive`) of upstream commit
  `c0771d0373d960dbcc961adf3226cf5109d38af8`, recorded in `vendor/logic-chain/UPSTREAM.md`. A copy was chosen over a
  submodule so `docker build` and `fly deploy` work from a plain checkout. To update it, run
  `scripts/sync-logic-chain.sh <sha>` (this also bumps `LOGIC_CHAIN_COMMIT`). Don't edit the vendored files by hand.
- **Least privilege.** The sidecar gets an allow-listed environment: PATH and locale, its data dir, its loopback port and
  token, the signing identity path, and only the provider keys it uses. Workspace, Shopify, Resend, Clerk, HF and other
  secrets never reach it. Key **values** never appear in the chain config, status, Library, record or logs. Only the env
  names do.
- **One run at a time.** The chain is single-job. A second start while one is running returns `409`.

## API

All routes are behind the workspace gate (`Authorization: Bearer <WORKSPACE_ACCESS_TOKEN>` or the login cookie).

| Method | Path | What it does |
|---|---|---|
| GET | `/api/logic-chain/status` | sidecar state, pinned commit, identity label, which provider keys are set (yes/no only), caps, default mode |
| POST | `/api/logic-chain/runs` | start a run: `{ objective, mode?: "mock"\|"live", approveSpend?, maxUsd?, maxPlanCalls? }` → `202` |
| GET | `/api/logic-chain/runs` | your recent runs |
| GET | `/api/logic-chain/runs/:id` | status, stages, MOCK/LIVE label, brief, Library ids, links; `?full=1` adds the full signed `run.json` |
| GET | `/api/logic-chain/runs/:id/verify` | signature, hash-link and ledger-replay check, plus the skill package's hashes and signature |
| GET | `/api/logic-chain/runs/:id/document` | the brief as markdown (MOCK banner on mock runs) |
| POST | `/api/logic-chain/runs/:id/cancel` | cancel an active run |
| GET | `/api/logic-chain/skills`, `/api/logic-chain/skills/:id` | skill packages from your runs (with the manifest) |
| POST | `/api/logic-chain/skills/:id/agents` | `{ agents: ["forge_keeper", ...] }` selects which agents may read the skill |

```bash
curl -s -X POST "$URL/api/logic-chain/runs" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"objective":"Design a rate limiter for a public JSON API"}'            # MOCK, free
curl -s "$URL/api/logic-chain/runs/<id>" -H "Authorization: Bearer $TOKEN"
curl -s "$URL/api/logic-chain/runs/<id>/verify" -H "Authorization: Bearer $TOKEN"
```

## Mock vs live (what is real)

| | mock (default) | live |
|---|---|---|
| Who answers each stage | upstream's labelled demo fixtures | real models through the server's provider keys |
| Network / cost | none / $0 | provider calls, capped |
| Label | `MOCK`, on the run, document, every Library title and tag, and skill | `LIVE` only when **every** stage used a real provider **and** real-provider stages actually completed. Any fixture stage makes it `MIXED (part MOCK)`. A finished live run where no stage completed (every call failed) is `FAILED` |
| Signing, verify, Library, skill package | real (same code path) | real |
| Needs | nothing | `mode: "live"`, `approveSpend: true`, the workspace **owner**, and at least one provider key |

The label comes from the stages the chain actually recorded, not from what was requested. A mock run can never be
shown as LIVE. A live run with no completed stage yet shows `PENDING`. A live run that finishes (or has every stage
fail) without a single completed real-provider stage is labelled `FAILED` on the run, `/verify`, Library titles
(`[FAILED] …`) and tags, because no model output exists. Its signed chain still verifies: it is an honest record of
the failed calls.

**HTTPS from the sidecar.** The Python sidecar's provider calls use the system CA store. The image installs
`ca-certificates` and sets `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` (passed through the sidecar's env
allow-list). Release v12 lacked the package and every live call failed with `SSL: CERTIFICATE_VERIFY_FAILED`.

**Spending caps** (live): `LOGIC_CHAIN_MAX_RUN_CENTS` (default **100 = $1.00**), `LOGIC_CHAIN_MAX_PLAN_CALLS` (default
**60**), `LOGIC_CHAIN_MAX_SECONDS` (default 3600). A request can lower them (`maxUsd`, `maxPlanCalls`) but never raise
them. The chain prices unknown models at its most expensive known rate, so the cap holds even for new model names.

**Live seats.** These are built from server-side env names only, in the order set by `LOGIC_CHAIN_PROVIDERS` (default
`xai,gemini`). OpenAI is seated only when that list includes `openai`. Only providers with a key are seated. The 8 roles rotate across them, and the Integrator, which
writes the brief, gets the first one.

| Provider | Key | Model (default) | Endpoint |
|---|---|---|---|
| xAI | `XAI_API_KEY`, else `PROMPT_LLM_API_KEY` when `PROMPT_LLM_BASE_URL` is `api.x.ai` (as in `fly.toml`) | `LOGIC_CHAIN_XAI_MODEL` (`grok-4.3`) | `https://api.x.ai/v1/chat/completions` |
| Gemini | `GEMINI_API_KEY` | `LOGIC_CHAIN_GEMINI_MODEL` (`gemini-3.5-flash-lite`) | Google Generative Language API |
| OpenAI | `OPENAI_API_KEY` | `LOGIC_CHAIN_OPENAI_MODEL`, else `OPENAI_MODEL`, else `gpt-4.1-mini` | `OPENAI_BASE_URL` if set (OpenAI-compatible router), else api.openai.com |

## Signing identity

- `FRAYMUS_IDENTITY_FILE`: path to an existing seed file. A **missing** path is refused (runs return `503`), because
  upstream would silently create a new key there.
- `FRAYMUS_IDENTITY_SEED`: the 64-hex Ed25519 seed as a secret. It is written at mode 0600 to a private temp dir (not
  the data volume) for the sidecar and removed on exit.
- Neither set: upstream auto-generates a key in `DATA_DIR/logic-chain/identity`. The status reports it as
  **`LOCAL KEY: auto-generated on this server ... not your Fraymus identity`**, and every run records which kind signed it.

## Library, record, skills

When a run finishes, Node verifies it, exports the skill package (when the ledger has content) and saves three Library
items of type **`logic`** (Library tab → "Logic Chain"):

- **Brief**: the markdown document, with the synthesis in `data`.
- **run.json (signed chain)**: the full run with every signed record. The meta holds the verify result, signer and
  chain head.
- **Skill package**: `skill.json` (the manifest), `CONTRACT.md` and `tests/test_acceptance.py`.

Each item's `meta` has `kind`, `label`, `runId`, `signer`, `head`, `verified` and `links` (API, verify, document,
run.json, and the other two Library ids). Titles and tags carry `MOCK`, `MIXED`, `LIVE` or `FAILED`. The episodic record (`/api/memory/record`) gets
`logic.run.start`, `logic.run.done` and `logic.skill.agents` events.

**Skills** are registered with `agents: []`. No agent can see them until the owner selects agents with
`POST /api/logic-chain/skills/:id/agents`. They are read-only specifications (`status: candidate_unverified`,
`executable: false`). Nothing is executed or auto-enabled.

## Agent tools

| Tool | Risk | What it does |
|---|---|---|
| `logic_chain_run` | approval | starts a run (mock unless `mode: "live"`) and waits for it. Needs approval in chat, so it is blocked in delegated or unattended runs |
| `logic_chain_status` | safe | one run, or the recent runs |
| `logic_chain_verify` | safe | verify a run and its package |
| `logic_chain_skills` | safe | the skill packages enabled for the calling agent |

Agents with `tools: *` (genesis, concierge, fraymus_prime, eye_sovereign) get all four. `forge_keeper` gets the three
safe ones. The tools are also callable over this app's MCP server (`call_tool`).

## Running it

- **With this app**: nothing extra to do. The Docker image installs `python3` (stdlib only, no pip packages). For
  `npm start`, install Python 3.10+. `docker compose up -d --build` runs the app and the sidecar together. Set
  `LOGIC_CHAIN=off` to disable it.
- **The Logic Chain alone** (its own UI, no app): `cd vendor/logic-chain && docker compose up --build`, then open
  `http://127.0.0.1:8765`. Or run `python3 run.py`.
- **An already-running chain on loopback**: set `LOGIC_CHAIN_URL=http://127.0.0.1:8765` and `FRAYMUS_SERVER_TOKEN`.
  The package check in verify is then skipped (the files live on the other process's disk).

## Env names

`LOGIC_CHAIN`, `LOGIC_CHAIN_PROVIDERS`, `XAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`,
`PROMPT_LLM_API_KEY`/`PROMPT_LLM_BASE_URL` (xAI fallback), `LOGIC_CHAIN_XAI_MODEL`, `LOGIC_CHAIN_GEMINI_MODEL`,
`LOGIC_CHAIN_OPENAI_MODEL`, `LOGIC_CHAIN_MAX_RUN_CENTS`, `LOGIC_CHAIN_MAX_PLAN_CALLS`, `LOGIC_CHAIN_MAX_SECONDS`,
`FRAYMUS_IDENTITY_FILE`, `FRAYMUS_IDENTITY_SEED`, `LOGIC_CHAIN_PYTHON`, `LOGIC_CHAIN_DIR`, `LOGIC_CHAIN_PORT`,
`LOGIC_CHAIN_URL` (+ `FRAYMUS_SERVER_TOKEN`), `LOGIC_CHAIN_OLLAMA_URL`, `LOGIC_CHAIN_POLL_MS`, `LOGIC_CHAIN_TOOL_WAIT_MS`.
They are described in [.env.example](../.env.example).

## Tests

`npm run test:logic-chain` runs three suites:

1. The vendored Python suite (`python3 -m unittest discover -s tests`, upstream's 317 tests).
2. `scripts/test-logic-chain-unit.ts`: key resolution, seats, caps, labels, identity, and the env allow-list.
3. `scripts/test-logic-chain.mjs`: a full mock run through the HTTP API against a real sidecar. It covers the gate,
   the guards, the MOCK label everywhere, verify and tamper detection, the document, the Library items, skills per
   agent, the agent tools over MCP, and the record events.

`npm test` includes 2 and 3. No provider key is used, and nothing touches the network.
