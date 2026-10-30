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

Recommended / optional:

- `CLERK_SECRET_KEY` (without it the workspace `/api/*` is open; the buyer `/enhance` page and webhooks don't need it)
- `VITE_CLERK_PUBLISHABLE_KEY` (build arg: `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=...`)
- `REPLICATE_API_TOKEN` (real AI upscale; otherwise a lanczos3 resize)

Override in `fly.toml` [env] if needed: `PROMPT_LLM`, `PROMPT_LLM_BASE_URL`, `PROMPT_LLM_MODEL`.

## CLI

    fly secrets set -a fraymus-fly-io HF_TOKEN=... PROMPT_LLM_API_KEY=... SHOPIFY_WEBHOOK_SECRET=... \
      RESEND_API_KEY=... MAIL_FROM=... PUBLIC_URL=https://fraymus-fly-io.fly.dev
    fly deploy -a fraymus-fly-io
    curl https://fraymus-fly-io.fly.dev/health

Only point the Shopify webhooks at one server (this Fly app or the VPS), not both, or
each paid order would be recorded twice in two separate databases.
