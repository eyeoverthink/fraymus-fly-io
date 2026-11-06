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
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`: the agents' chat model (`LLM_PROVIDERS=openai,groq`).
  Hostinger AI Router: `OPENAI_BASE_URL=https://router.hostinger.com/v1`, `OPENAI_MODEL=gpt-5.6-luna`
  (`OPENAI_USER_AGENT` is set in `fly.toml`; the router needs a non-default UA). Or `GROQ_API_KEY`.

Recommended / optional:

- `CLERK_SECRET_KEY` (replaces the shared-secret gate with Clerk sign-in; the buyer `/enhance` page and webhooks don't need it)
- `VITE_CLERK_PUBLISHABLE_KEY` (build arg: `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=...`)
- `REPLICATE_API_TOKEN` does nothing for images unless `ENABLE_PAID_REPLICATE=1` is also set in `[env]` (already `0` in `fly.toml`). That route is pay-per-prediction. Upscale stays a local Sharp resize, which is not AI upscaling, and a missing Replicate upscale does not fail a buyer run.
- Image generation (`fly.toml` `[env]`, not secrets): `IMAGE_PROVIDERS=hf-fal,pollinations,placeholder` and `BUYER_IMAGE_PROVIDERS=hf-fal`. Hugging Face fal-ai FLUX.1-schnell spends included PRO credits (about $2/month; FLUX schnell is about $0.003 per megapixel). The app keeps a local estimate and stops HF at `IMAGE_MONTHLY_CREDIT_CAP_USD=1.50` so $0.50 remains for other HF use. This is not a live balance: one shared HF account on several machines can still overshoot, and the invoice is the source of truth. nscale is deprecated (HTTP 410) and is not in the default list. Pollinations is anonymous, watermarked, one request at a time, and may cache prompts publicly, so do not send confidential text. Buyer runs use only `hf-fal` and refund when it cannot produce an image. OpenAI Images is never called. Gemini image generation stays off until included-credit billing is confirmed.

FRAYMUS Logic Chain (all optional; with none set, runs are MOCK and signed by a labelled LOCAL KEY, see docs/LOGIC-CHAIN.md):

- `XAI_API_KEY` (optional: the existing `PROMPT_LLM_API_KEY` is reused for xAI because `PROMPT_LLM_BASE_URL` is api.x.ai)
- `GEMINI_API_KEY`
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` above are reused for the OpenAI seat (`LOGIC_CHAIN_OPENAI_MODEL` overrides the model)
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
