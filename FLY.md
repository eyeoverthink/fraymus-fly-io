# Deploying fraymus-fly-io on Fly.io

This repo root is the app root: `Dockerfile` and `fly.toml` are here, so Fly's
"Launch from repository" (and `flyctl launch --copy-config`) finds them directly.

- App: `fraymus-fly-io`, org `vaughn-scott`, region `ams`
- One always-on machine (2 CPU / 2 GB), never scale past 1 (SQLite)
- Volume `nodular_data` (3 GB) mounted at `/data`; internal port `3001`; health check `/health`
- Strict buyer pipeline (`BUYER_PIPELINE_STRICT=1`), `FREE_CREDITS=0`, 25 credits per pack
- Prompt step: xAI, OpenAI-compatible (`PROMPT_LLM`, `PROMPT_LLM_BASE_URL`, `PROMPT_LLM_MODEL` are set in `fly.toml`)

## Secrets (set with `fly secrets set` or the dashboard; never commit values)

Required:

- `HF_TOKEN`
- `PROMPT_LLM_API_KEY` (xAI key)
- `SHOPIFY_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `PUBLIC_URL` (e.g. `https://fraymus-fly-io.fly.dev`)

Workspace (agents + chat UI at `/`):

- `WORKSPACE_ACCESS_TOKEN` (random, >= 24 chars, e.g. `openssl rand -hex 24`). Without Clerk this is the
  shared secret for the workspace: open `https://fraymus-fly-io.fly.dev/login` and paste it once (sets a 30-day
  httpOnly cookie), or send `Authorization: Bearer <token>` to `/api/*`. If it's missing, the workspace fails
  closed (every `/api/*` returns 401). Never gated: `/health`, `/enhance`, `/buyer/*`, `/webhooks/shopify`, `/outputs/*`.
- Chat does not need a new secret. `LLM_PROVIDERS=xai,groq` in `fly.toml` sends agent chat to `https://api.x.ai/v1` with the existing `PROMPT_LLM_API_KEY` (the prompt step already uses that key against `PROMPT_LLM_BASE_URL=https://api.x.ai/v1`). Model is `PROMPT_LLM_MODEL` (`grok-4.20-0309-non-reasoning`). Groq is skipped unless `GROQ_API_KEY` is set. `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` are not used for chat unless `LLM_PROVIDERS` includes `openai`.

Recommended / optional:

- `CLERK_SECRET_KEY` (replaces the shared-secret gate with Clerk sign-in; the buyer `/enhance` page and webhooks don't need it)
- `VITE_CLERK_PUBLISHABLE_KEY` (build arg: `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=...`)
- `REPLICATE_API_TOKEN` does nothing unless `IMAGE_PROVIDERS` lists `replicate` and, for upscale, `ENABLE_PAID_REPLICATE=1` (already `0` in `fly.toml`). Upscale stays a local Sharp resize, which is not AI upscaling, and a missing Replicate upscale does not fail a buyer run.
- Image generation (`fly.toml` `[env]`, not secrets): `IMAGE_PROVIDERS=huggingface,gemini,pollinations,local`, `BUYER_IMAGE_PROVIDERS=huggingface`, `HF_FLUX_PROVIDER=fal-ai`, `HF_FLUX_MODEL=black-forest-labs/FLUX.1-schnell`, `IMAGE_MONTHLY_CREDIT_CAP_USD=1.50`, `IMAGE_ALLOW_PAID_OVERRUN=false`. `HF_TOKEN` calls `router.huggingface.co/fal-ai/fal-ai/flux/schnell`. That draws on included Inference Providers credits (Pro is $2/month; a free account currently has none). The $1.50 cap is a local estimate at $0.003 per megapixel, not the invoice, and it stops Hugging Face before pay-as-you-go. Preview then uses Pollinations. Buyer runs refund. A 402 from Hugging Face stops further Hugging Face calls for the month. hf-inference is not used (FLUX returns HTTP 410 there). Gemini runs only if `GEMINI_API_KEY` is set. Pollinations is anonymous, watermarked, one request at a time, and may cache prompts publicly. OpenAI Images is called only when `IMAGE_PROVIDERS` lists `openai` and `OPENAI_API_KEY` is set, and that call goes to `api.openai.com`, not to `OPENAI_BASE_URL`.

FRAYMUS Logic Chain (all optional; with none set, runs are MOCK and signed by a labelled LOCAL KEY, see docs/LOGIC-CHAIN.md):

- `XAI_API_KEY` (optional: the existing `PROMPT_LLM_API_KEY` is reused for xAI because `PROMPT_LLM_BASE_URL` is api.x.ai)
- `GEMINI_API_KEY`
- The OpenAI seat is off unless `LOGIC_CHAIN_PROVIDERS` includes `openai`. Default seats are `xai,gemini` (only those with a key). `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` are reused for that seat when it is opted in (`LOGIC_CHAIN_OPENAI_MODEL` overrides the model)
- `FRAYMUS_IDENTITY_SEED` (64 hex chars, your Fraymus Ed25519 seed) so runs are signed by your identity instead of a local key
- Caps (plain env, not secret): `LOGIC_CHAIN_MAX_RUN_CENTS` (default 100), `LOGIC_CHAIN_MAX_PLAN_CALLS` (default 60)

The sidecar runs inside the same machine (child process on 127.0.0.1). It needs no `[processes]` entry, service or port,
and keeps its runs on the volume at `/data/logic-chain`.

Override in `fly.toml` [env] if needed: `PROMPT_LLM`, `PROMPT_LLM_BASE_URL`, `PROMPT_LLM_MODEL`.

## CLI

    fly secrets set -a fraymus-fly-io HF_TOKEN=... PROMPT_LLM_API_KEY=... SHOPIFY_WEBHOOK_SECRET=... \
      RESEND_API_KEY=... MAIL_FROM=... PUBLIC_URL=https://fraymus-fly-io.fly.dev
    fly deploy -a fraymus-fly-io
    curl https://fraymus-fly-io.fly.dev/health

The Shopify webhooks point at this Fly app only (owned by the Chandra-Fraymus app). The VPS copy
(2.24.68.223, /opt/fraymus-credits) is old and not production; never point webhooks at it too, or
each paid order would be recorded twice in two separate databases. See docs/FLY-CANON.md.
