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
- `REPLICATE_API_TOKEN` (real AI upscale; otherwise a lanczos3 resize)

Override in `fly.toml` [env] if needed: `PROMPT_LLM`, `PROMPT_LLM_BASE_URL`, `PROMPT_LLM_MODEL`.

## CLI

    fly secrets set -a fraymus-fly-io HF_TOKEN=... PROMPT_LLM_API_KEY=... SHOPIFY_WEBHOOK_SECRET=... \
      RESEND_API_KEY=... MAIL_FROM=... PUBLIC_URL=https://fraymus-fly-io.fly.dev
    fly deploy -a fraymus-fly-io
    curl https://fraymus-fly-io.fly.dev/health

The Shopify webhooks point at this Fly app only (owned by the Chandra-Fraymus app). The VPS copy
(2.24.68.223, /opt/fraymus-credits) is old and not production; never point webhooks at it too, or
each paid order would be recorded twice in two separate databases. See docs/FLY-CANON.md.
