# Costs and access methods

What each provider costs, how this app reaches it, and which models are worth paying for. Prices were checked on 2 November 2026 and will change, so confirm them before budgeting. Back to the [README](../README.md) or the [docs index](README.md).

## The short version

- **Curl and the app's API calls are the same thing.** Both are HTTP requests at the same token prices. The real choice is API or Ollama credits (pay by the token) against a membership CLI (draws on plan limits).
- **Model choice matters far more than method.** On Ollama Cloud, `kimi-k3` costs 21 times as much per input token as `mimo-v2.6-flash`, and 54 times as much per output token.
- **A cheaper review panel matched the current one** on 48 known answers, at an estimated 60% lower review cost.
- **Codex was on OpenAI's most expensive tier by default.** Set a model explicitly.
- **Applied on 2 November 2026:** the cheaper seats and Codex on `gpt-5.6-terra` cut a matching real run from $0.49 to $0.35 at list prices, a 28% drop. The next sections describe the setup before that change.

## What this app uses today

| Slot | Provider | Method | Paid by | Status |
| --- | --- | --- | --- | --- |
| Architect, Integrator | Codex default, GPT-6 Astra | CLI | ChatGPT plan limits | Ready |
| Algorithm | `gemini-pro-latest` | HTTP API, key | Per token | Ready |
| Data Model | `grok-4.7` | HTTP API, key | Per token | Ready |
| Implementation | `deepseek-v4.1-flash:cloud` | Local Ollama app to Ollama Cloud | Ollama credits per token | Ready |
| Critic | `kimi-k3:cloud` | Same | Same | Ready |
| Test Designer | `minimax-m3:cloud` | Same | Same | Ready |
| Optimizer | `mistral-large-4:cloud` | Same | Same | Ready |

Not connected: Claude CLI (not signed in), GitHub Models (needs the `models:read` scope), and API keys for Anthropic and OpenAI.

## Methods by provider

| Provider | Methods | How it's paid | Notes |
| --- | --- | --- | --- |
| Ollama Cloud | Local app, or direct `https://ollama.com/api/chat` with `OLLAMA_API_KEY` | Tokens at each model's rate, from monthly credits. Pro is $20 for $60 of credits, Max is $100 for $300 | Direct calls need no local app, at the same rates. Credits don't roll over. Pro runs 3 models at once, Max 10 |
| Gemini | HTTP API with a key, or Gemini CLI | API by the token, thinking billed as output. CLI sign-in has daily request quotas: 1,500 on AI Pro, 2,000 on AI Ultra | The app has no Gemini CLI adapter yet. Batch costs half but isn't live |
| xAI | HTTP API with a key | By the token, with reasoning tokens billed. Reasoning can be lowered with `reasoning.effort` but not turned off | SuperGrok and API credits look like separate pools. xAI's own docs didn't confirm this |
| OpenAI | Codex CLI on a ChatGPT plan, or API key | Plan limits, or API prices with a key | A ChatGPT login rejected `gpt-6-luna` and `gpt-6.1-terra`, but accepted `gpt-5.6-terra` and `gpt-5.6-luna` |
| Anthropic | Claude CLI on a plan, or API key | Plan limits, or API prices. `claude -p` on a personal plan draws on plan limits | Max gets $100 of API credits a month and Ultra $200, with no rollover. Anthropic's pages disagree on whether these cover `claude -p` with a key, and the API itself is covered. Products for other people must use API keys |
| GitHub Models | HTTP API with a GitHub token | Free tier with low limits, then token units | Copilot terms changed in June 2026, and the current terms for this route weren't confirmed |

## Prices that matter here

US dollars per million tokens, standard rates.

| Model | Route | Input | Cached input | Output |
| --- | --- | ---:| ---:| ---:|
| `mimo-v2.6-flash` | Ollama | 0.14 | 0.0028 | 0.28 |
| `deepseek-v4.1-flash` | Ollama | 0.30 | 0.006 | 1.20 |
| `minimax-m3` | Ollama | 0.60 | 0.12 | 2.40 |
| `mistral-large-4` | Ollama | 0.70 | 0.07 | 2.10 |
| `kimi-k2.7-code` | Ollama | 0.95 | 0.19 | 4.00 |
| `kimi-k3` | Ollama | 3.00 | 0.30 | 15.00 |
| `gemini-3.5-flash-lite` | Gemini API | 0.30 | 0.03 | 2.50 |
| `gemini-3.1-pro-preview` | Gemini API | 2.00 | 0.20 | 12.00 |
| `grok-build-0.1` | xAI | 1.00 | 0.20 | 2.00 |
| `grok-4.7` | xAI | 2.00 | 0.50 | 6.00 |

Ollama lists half-price off-peak rates for `deepseek-v4.1-flash`. Its off-peak hours are outside 12:00 to 18:00 UTC on weekdays, plus weekends. Prices come from each provider's page, and xAI's were confirmed through its live API. `gemini-pro-latest` is an alias, and the pricing page doesn't say which model it points to. The cost below assumes $2 and $12.

ChatGPT plans use credits instead of dollars. Per million tokens, GPT-6 Astra costs 250 credits in and 1,250 out, and GPT-5.6 Terra 50 in and 300 out. Plus is estimated at 5 to 45 Astra messages per five hours.

## What a real run cost

A real run (`cc24f687d38149d3`, 34 calls, 245,462 tokens) at list prices, ignoring cache discounts:

| Provider | Calls | Tokens | List cost |
| --- | ---:| ---:| ---:|
| `grok-4.7` | 2 | 34,216 | $0.152 |
| `kimi-k3` | 6 | 29,277 | $0.148 |
| `gemini-pro-latest` | 2 | 15,359 | $0.083 |
| `mistral-large-4` | 7 | 50,723 | $0.059 |
| `minimax-m3` | 6 | 34,643 | $0.035 |
| `deepseek-v4.1-flash` | 6 | 27,959 | $0.014 |
| **Priced total** | 29 | 192,177 | **$0.49** |
| Codex, plan limits | 5 | 53,285 | Not in dollars |

About $0.26 of that is Ollama credits, so $60 of credits would cover roughly 230 runs like this one. Providers' invoices were not checked against these estimates.

## Benchmark results for cheaper models

Each row is one run on the 48 known answers. Scores moved by a few points between runs, so small gaps mean little. These measure review judgment only. **Nothing here measures how good a model's stage work or briefs are.**

| Model | Right | Real issues found | Cost for 48 cases | Passes the bar |
| --- | ---:| ---:| ---:| --- |
| `mistral-large-4` | 98–100% | 100% | not measured in dollars | Yes |
| `mimo-v2.6-flash` | 98–100% | 94–100% | $0.0006 | Yes |
| `gpt-5.6-terra`, Codex | 94–98% | 88–94% | Plan limits | Mixed |
| `grok-build-0.1` | 98% | 100% | $0.048 | Yes |
| `grok-4.3` | 96% | 94% | $0.023 | Yes |
| `deepseek-v4.1-flash` | 94–96% | 94% | not measured in dollars | Yes |
| `kimi-k2.7-code` | 92–94% | 100% | $0.005 | Yes |
| `gemini-3.5-flash-lite` | 92–94% | 88–94% | $0.002 | Mixed |
| `deepseek-v4-pro` | 88% | 94% | $0.007 | Yes |
| `minimax-m3.1-flash` | 96% | 88% | $0.002 | No |
| `glm-5.3-flash` | 96% | 88% | $0.011 | No |
| `gemini-3.8-flash` | 92% | 75% | $0.048 | No |
| `gpt-oss:120b` | 92% | 88% | $0.004 | No |
| `gpt-5.6-luna`, Codex | 90% | 81% | Plan limits | No |

A live four-seat panel of Mistral, MiMo, Kimi K2.7 and DeepSeek Flash dismissed 0 of 16 real issues, sent 4 of 32 non-issues to the person, and was right on 43 of 43 agreed answers. Those are the same panel numbers as the current seats. Measured review usage on a real run puts the review at about $0.09 for the current seats and $0.035 for this panel. That is an estimate from one run.

## Method costs

- **Membership CLIs add overhead.** Codex used about 7,000 tokens per benchmark call, against about 500 over HTTP for the same prompts, because it carries its own agent instructions. Those tokens count against your plan limits.
- **Reasoning can dominate.** `grok-build-0.1` spent 20,927 of its 26,406 benchmark tokens on reasoning.
- **Codex's rate limit probably came from its model tier.** On Astra it stopped after 5 of 8 scenarios. `gpt-5.6-terra` and `gpt-5.6-luna` each finished all 8, at the same time. This fits Astra's small allowance, but it's one run on an unknown plan.
- **Prompt caching won't help the stages much.** Stage prompts start with the stage number, and each slot only returns 8 stages later, so a saved prefix is unlikely. Moving the shared text first might help review calls, which is untested.
- **Batch pricing doesn't suit this app.** It halves Gemini and Anthropic prices, but a chain needs each stage's result before the next can start.

## Applied change and result

MiMo and Kimi K2.7 took the Test Designer and Critic slots from MiniMax M3 and Kimi K3, and Codex moved to `gpt-5.6-terra`. A fresh benchmark seated MiMo, Mistral, DeepSeek Flash and Kimi K2.7. That panel dismissed 0 of 16 real issues, sent 6 of 32 non-issues to the person, and was right on 41 of 41 agreed answers.

| Same objective | Before | After |
| --- | ---:| ---:|
| List cost | $0.49 | $0.35 |
| Calls | 34 | 38 |
| Warnings | 141 | 162 |
| Warnings cleared | 14 | 13 |
| Run time | 17 minutes | 12 minutes |
| Brief length | 24,294 characters | 12,323 to 14,823 |

Two things changed that the benchmark doesn't cover. Briefs from `gpt-5.6-terra` were shorter, and whether they lost substance hasn't been measured. Terra also fell below the bar in its second run, finding 88% of real issues, so it holds no review seat.

## Remaining recommendations

1. **Review `grok-4.7` as a stage slot.** It is now the largest single priced cost. Stage quality hasn't been measured, so this needs a before-and-after comparison.
2. **Compare Terra's briefs with Astra's** before treating the shorter length as a saving.

## Not verified

- Your actual plan tiers and account balances, which affect limits but not these list prices.
- Whether cached rates apply to this app's calls. The usage it records doesn't separate cached tokens.
- Which model `gemini-pro-latest` points to.
- Whether the stage work of cheaper models holds up. They've only been tested on review judgment.
- Gemini CLI, SuperGrok and Copilot routes, which aren't connected here.

## Sources

- [Ollama pricing](https://ollama.com/pricing) and [Ollama Cloud docs](https://docs.ollama.com/cloud)
- [Gemini API pricing](https://aistudio.google.com/docs/pricing) and [Gemini CLI quotas](https://geminicli.com/docs/resources/quota-and-pricing/)
- [xAI models and pricing](https://docs.x.ai/docs/models) and [xAI reasoning](https://docs.x.ai/docs/guides/reasoning)
- [Codex pricing](https://learn.chatgpt.com/docs/pricing)
- [Claude Code on your plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [Agent SDK on your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [API credits for subscribers](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers), and [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [GitHub Models costs](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/costs-for-github-models) and [Copilot plan changes](https://github.blog/news-insights/company-news/changes-to-github-copilot-individual-plans/)
- Cross-checks: [OpenRouter model list](https://openrouter.ai/api/v1/models) and [LiteLLM price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
