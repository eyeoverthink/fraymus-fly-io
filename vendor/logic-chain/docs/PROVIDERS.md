# Providers

How to connect models, what each one costs, and what has been tested for real. For prices and which models are worth paying for, see [COSTS.md](COSTS.md). Back to the [README](../README.md) or the [docs index](README.md).

Open **Providers** in the app. **Connections** shows what is ready and the exact next step for anything that isn't. **Use recommended mix** spreads the eight roles across every ready provider and gives the Integrator, which also writes the brief, your strongest one. Settings are saved to `config/providers.json`, which stays out of git.

A membership is not usually an API key, so there are three ways in:

| Access | Provider | Setup | `kind` |
| --- | --- | --- | --- |
| Local | Ollama | Start Ollama | `ollama` |
| Membership | Ollama Cloud | `ollama signin`; use `:cloud` model names | `ollama` |
| Membership | Claude | `claude auth login` | `claude_cli` |
| Membership | ChatGPT | `codex login` | `codex_cli` |
| Membership | GitHub Models | `gh auth login` | `github_models` |
| API key | Anthropic, OpenAI, Gemini | Key in `.env` | `anthropic`, `openai`, `gemini` |
| API key | xAI, other compatible servers | Key in `.env`, plus `url` and key variable | `openai_compatible` |

For xAI use the URL `https://api.x.ai/v1/chat/completions` and the key variable `XAI_API_KEY`.

**Membership CLIs run locked down.** Claude Code and Codex are agents that can run commands, so the app starts them with every tool, MCP server and web search off, in an empty temporary folder, with the prompt on stdin and never on the command line. Model output cannot trigger anything on your machine. Each call counts against your plan's usage limits.

**API keys:** copy `.env.example` to `.env` and fill in only what you use. It stays out of git, and values already set in your shell win. The app stores a key variable's name, which must end in `_KEY`, and never its value.

Sending data off this machine takes two approvals: **Allow providers outside this machine** in Providers, and a checkbox on each run, including each resumed run. Ollama Cloud models and membership CLIs count as remote, even though they run through a local program.

**Cost:** the 16 stages and the brief make up to 33 model calls if every stage retries once. The review adds one call per 40 warnings for each reviewer, plus one to group them. A real run of about 160 warnings with four reviewers adds 21. API providers bill per token. Ollama Cloud spends your plan's dollar credits per token. Membership CLIs use your plan's limits.

**Caps:** each run stops at an estimated $2.00 of per-token and credit spend, or at 60 plan calls. Change either under Run limits in Providers, and 0 turns one off. Plan calls have no dollar price, so they count by calls instead. Dollars are list prices from `app/prices.json`, which ignore cache discounts and can go stale, and a model not listed there is assumed to cost as much as the priciest listed one. A cap is checked before each step, so a call already running can overshoot it: a real 5 cent cap stopped at 11 cents. Everything so far is saved, and you can raise the cap and press **Resume run**.

**Measured usage:** the **Usage** tab shows each run's calls and tokens by step and provider, as providers report them, and marks any estimate. It also estimates dollars at list prices. A real run on 2 November 2026 made 34 calls and used 245,462 tokens: 172,081 in the stages, 44,134 in the review, 14,084 in grouping and 15,163 in the brief. Grok's total included 16,769 tokens beyond its input and output, nearly as many as those two combined, so its total is the number to trust. Claude's CLI reports nothing to the app, so its tokens would be estimated.

**Output tokens:** some models think before answering, and that thinking can use the same token budget. Ollama Cloud models run with thinking off and need a generous limit, so the recommended mix uses 16,000. Local models are capped at 4,000.

**Which models suit which job:** a ledger reaches about 9,000 tokens. Small local models can echo it back instead of answering, and GLM can spend its whole limit reasoning without replying, so the recommended mix leaves both out when enough strong providers are ready. You can still choose them in Providers.

**What has been proven with real calls:** a full 16-stage run across Ollama Cloud (DeepSeek, Kimi, GLM, MiniMax, Mistral), local Ollama and ChatGPT through Codex completed every stage on the first attempt. Claude and GitHub Models have only been checked against mocked calls. The OpenAI, compatible, Anthropic and Ollama adapters are also tested over real HTTP against a local fake server (`tests/test_live_http.py`), which checks wire formats, auth headers, retries, and that keys never reach the run file. That proves the plumbing, not any provider's current API.

The **Test** button sends one full-size stage through the real parser and reports the findings it got back, so it can take a minute. A short ping proves a provider is reachable, not that it can do the work.

**Docker and remote Ollama:** set `FRAYMUS_OLLAMA_URL` to reach Ollama somewhere else. Compose sets it to `http://host.docker.internal:11434`. `FRAYMUS_LOCAL_HOSTS` lists extra host names that count as this machine, so they skip the remote approval.

Eight slots can point at one model. The chain still runs, but that isn't eight independent opinions.
