# FRAYMUS Logic Chain

**Eight AI roles work through one objective, twice, and hand you a readable brief.** Each stage receives your original objective and everything accumulated so far, adds structured findings, and passes the ledger on. Every entry records which stage produced it, and warnings are never dropped.

It runs on your machine, using your local models, your memberships or your API keys, with nothing to install beyond Python.

> **What it is not:** a run produces a design proposal, not working software. It does not generate or execute code, prove claims, or validate its own output. Agreement between models is not evidence that something is correct. Everything it produces is labelled unverified, and exported skills are specifications marked `candidate_unverified`.

## Start in under a minute

Requires **Python 3.10+**. No pip packages and no build step.

```bash
cd FRAYMUS-Logic-Chain
python3 run.py
```

Open **http://127.0.0.1:8765**, type an objective and press **Run chain**.

If [Ollama](https://ollama.com) is running, your installed models fill the eight slots automatically. If it isn't, the app uses synthetic demo fixtures and tells you so on screen: those echo your objective but no AI reads it.

Run the tests with:

```bash
python3 -m unittest discover -s tests
```

Tests use a temporary folder and never touch your runs or settings. They need no keys and no internet. Real REST adapters are tested against a fake provider on loopback.

### With Docker

```bash
cp .env.example .env    # optional: add only the keys you use
docker compose up --build
```

Open **http://127.0.0.1:8765**. Runs, skills, settings and the signing key are kept in the `fraymus-data` volume. The container reaches Ollama on your host through `host.docker.internal`. The compose file has not been tested yet: the machine this was built on has no Docker.

### Verify a run

Every stage is Ed25519-signed and hash-linked in the Fraymus form. To check a run:

```bash
python3 run.py verify <run-id>
```

You can also press **Verify** in the app. See [docs/SIGNING.md](docs/SIGNING.md).

On Windows: run files and skill packages are written as raw UTF-8 bytes with `\n` line endings, so signed hashes match on every OS. Use `python run.py verify <id>`. If git checks out with `autocrlf`, verify the exported folder, not a re-checked-out copy. The Unix 0600 key-file permission test is skipped on Windows.

## What is real and what is mocked

| Part | Status |
| --- | --- |
| Provider adapters: OpenAI, OpenAI-compatible, Anthropic, Ollama, Gemini, GitHub Models, Claude and Codex CLIs | **Real** HTTP and CLI calls. Keys come only from server-side env or `.env`, never the browser. OpenAI, compatible, Anthropic and Ollama are tested end to end over HTTP against a local fake server; no real key was used in the tests. |
| Relay loop, `merge` (ValidateMerge), review, brief | **Real**. Deterministic, unit-tested. |
| Demo provider | **MOCK.** Fixtures that echo your objective. No AI reads it. Runs made only with it are labelled `mode: mock` and show a MOCK banner and chip. Nothing labels them live. |
| Signed chain and verify | **Real** Ed25519 (RFC 8032 vectors), hash-linked, verified by replay. Uses a local key unless you point `FRAYMUS_IDENTITY_FILE` at your Fraymus seed. |
| Exported skill package | **Real files.** The contract and its tests are proposals, and each one is skipped as `not_implemented`. No code is generated or run. |
| `examples/quantum_container` | **Hand-written** reference, not run output. A unitary state-vector simulator that fixes the HTML mock's norm bug and unused `h`. |
| Docker | Written, **not yet tested**. |

## How a run works

1. You submit one objective.
2. Stage 1 receives it with an empty ledger and returns structured JSON: new logic, refinements, contradictions, implementation steps, proposed tests, unsupported claims and dependencies.
3. The ledger merges the findings, dropping duplicates and recording which stage added each one.
4. Stages 2 to 8 each receive the **unchanged objective plus the ledger**, working from their own role: Architect, Algorithm, Data Model, Implementation, Critic, Test Designer, Optimizer, Integrator.
5. Stages 9 to 16 repeat the same eight slots, now refining and looking for contradictions.
6. Up to five independent providers **vote** on every warning, 40 to a call, without seeing other votes and never on their own claims. An item is settled only at 80% agreement with at least two votes. Everything else goes to **Decisions** for you, with the reason.
7. One final model call writes the **brief**, a readable document built only from the ledger.

Progress streams live. If a stage fails, the chain carries on with what it has. Each stage is saved as it finishes to `runs/<id>.json`, including raw output and errors. If the app stops mid-run, open the run and press **Resume run**.

## Using the app

| Action | How |
| --- | --- |
| Run | **Run chain**, or `⌘↵` |
| Stop | **Cancel run** stops immediately |
| Continue after a crash or a cap | Open the run and press **Resume run** |
| Commands and run search | `⌘K` |
| New run | `N` |
| Inspect a stage | Click any stage; failed stages open their raw output |
| Trace an entry | Click its stage tag in the Ledger |
| See what needs you | The **Decisions** tab lists what reviewers couldn't settle |
| See what a run used | The **Usage** tab shows calls, tokens and estimated cost by step and provider |
| Check plan quality | **Quality** scores test objectives against fixed checklists |
| Choose models | **Providers**, with a **Test** button per slot |
| Keep the result | Copy, download as Markdown, or export a candidate skill package |
| Check it | **Verify** checks every signature, the hash links, and a replay of the ledger |

## Providers

Open **Providers** in the app. **Connections** shows what is ready and the exact next step for anything that isn't, and **Use recommended mix** spreads the eight roles across every ready provider.

It works with local Ollama, Ollama Cloud, Claude and ChatGPT memberships, GitHub Models, and API keys for Anthropic, OpenAI, Gemini, xAI and compatible servers. Sending data off this machine always takes your explicit approval.

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for setup and what has been tested with real calls, and [docs/COSTS.md](docs/COSTS.md) for prices, access methods and cheaper models that passed the benchmark.

## Review and benchmark

Reviewers vote on every warning, and whatever they can't settle comes to you as grouped decisions in the **Decisions** tab. Seats go to the providers that score best in the built-in **Benchmark**, which tests them on warnings with known answers.

Votes are not proof. They show whether models agree, and a cleared warning is a weak signal. See [docs/REVIEW.md](docs/REVIEW.md) for the rules and the measurements.

## Quality

The **Quality** test checks whether a plan made the decisions its objective needs, using fixed checklists and judges tested on known answers. It raised average brief coverage from under 1 of 10 to 4 to 7 of 10 by exposing a context bug. It also traces each brief's claims to the ledger, with fake claims hidden among them to prove the check works. In four current briefs, it found no invented numbers, names or mechanisms. Judges answer one checklist item per call, because one judge let its view of a whole brief decide every item. A full test costs about $2.20. Coverage and tracing are not correctness. See [docs/QUALITY.md](docs/QUALITY.md).

## Security and privacy

- The server binds to `127.0.0.1` and rejects foreign `Host` and `Origin` headers. Do not expose it through a reverse proxy.
- Keys stay server-side. Every run is signed with a local Ed25519 key in `identity/` (mode 0600). Anyone holding that key can sign, so treat it like a password. Set `FRAYMUS_SERVER_TOKEN` to require a token for API routes.
- `runs/` stores your objective and all model output in plaintext. Keep credentials out of objectives, and delete runs you don't need to keep.
- Provider output is never executed. It renders as inert text.
- Prompt instructions cannot fully stop prompt injection. Treat all generated content as untrusted until you've tested it yourself.

## Limits

- Exactly 8 slots and 2 passes.
- Deduplication ignores case and spacing, but not meaning.
- Non-warning fields are capped at 250 entries, and any drops are reported. Contradictions and unsupported claims are never capped.
- Prompt context is bounded by `max_context_chars`. All warnings are always included, and the design gets at least half the limit on top of them, so a prompt can exceed the limit. Design entries alternate earliest and newest, with omissions reported to the model. A brief with grouped warnings gets the groups instead.
- Long items are clipped at 1,000 characters.
- Cancelling abandons a model call in flight, but a provider may still finish and bill it, and a membership CLI keeps running until it finishes or times out.
- The time budget is checked between stages, so a stage in progress can overrun it by up to its own timeout.
- Resume applies to interrupted and capped runs, not cancelled ones. It uses your current provider settings and starts a new time budget.
- A run stops at an estimated $2.00 or 60 plan calls by default. A call already running can overshoot a cap. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- One run at a time.

## Project map

| Folder | What's in it |
| --- | --- |
| [app/](app/README.md) | The engine, review, benchmark, server and interface |
| [config/](config/README.md) | Example provider settings |
| [docs/](docs/README.md) | Providers, review, architecture and API guides |
| [tests/](tests/README.md) | Automated tests |
| [examples/](examples/quantum_container/README.md) | A hand-written reference skill |
| `runs/`, `skills/`, `benchmarks/`, `identity/` | Your local results and signing key, kept out of git |

## Roadmap

- **Next:** semantic deduplication, structured output on cloud providers, a second author for the test checklists.
- **Later:** code generation, with tests run in an isolated sandbox and human approval.

Start with the [docs index](docs/README.md) for the full design and the HTTP routes.
