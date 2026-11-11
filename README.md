# FreeRouter

FreeRouter is a self-hosted, OpenAI-compatible gateway for Google AI Studio, NVIDIA NIM, OpenRouter, Mistral AI, Matilda (Maincode), ZenMux, OrcaRouter, and TokenHarbor models. Provider access and included usage depend on each account. It also exposes TypeSafe Jev as a separate Decisions API and native System One endpoint. The dashboard uses a rotating six-digit shared password delivered over SMTP; registered email addresses receive password mail, and the first address is required at login only until a second recipient is added. Generated `sk-fr-` keys authorize `/v1` API calls.

## Current implementation

This repository contains a runnable Next.js 16 gateway (Node.js 24, Fluid Compute) with:

- **Provider integrations**: Google AI Studio, NVIDIA NIM, OpenRouter, Mistral AI, Matilda (Maincode), ZenMux, OrcaRouter, TokenHarbor
- **Model registry**: `src/lib/models/catalog.ts` with capability states (passed/failed/unknown/unsupported), readiness statuses (ready/experimental/unavailable/restricted), and dated probe evidence
- **Chat Completions**: `/v1/chat/completions` with SSE streaming and JSON responses, tool calls, strict JSON Schema validation, vision, reasoning effort, and alias routing (`fr-fast`, `fr-code`, `fr-quality`, `fr-vision`, `fr-auto`)
- **Responses API**: `/v1/responses` with stored state (encrypted, 24-hour expiry), streaming, retrieval, deletion, and input-item listing
- **Embeddings**: `/v1/embeddings` with explicit model IDs, dimensions, retrieval modes (`query`/`passage`), float/base64 output, and dedicated `embeddings` scope
- **Jev / Decisions**: `/v1/systemone` (native), `/v1/decisions` (OpenAI Decisions adapter), `/v1/models?type=decision` discovery
- **Quota ledger**: Local Upstash Redis admission with per-minute and provider-local-day request/token windows, observe/enforce modes, admin dashboard
- **Admin dashboard**: Provider credential management (encrypted in MongoDB), API key management with scopes/expiry/revocation, user management, quota monitoring, playground
- **Authentication**: SMTP-delivered shared six-digit password, signed 30-day cookies, failed-login throttling, bootstrap from `SMTP_USER`

The model catalog in `src/lib/models/catalog.ts` is a dated probe snapshot. Availability changes; administrators should use the model page and run live checks before enabling a newly discovered model. The implementation is a functional release candidate with documented release gates in [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Quick start

### Prerequisites
- Node.js 24.x
- pnpm
- MongoDB (Atlas or compatible)
- Upstash Redis
- SMTP credentials (Gmail app password recommended)

### Local development

```sh
# Clone and install
pnpm install --frozen-lockfile

# Copy environment template and fill values
cp .env.example .env

# Run development server
pnpm dev
```

Open `http://localhost:3000`. The first password recipient is bootstrapped from `SMTP_USER`: request a sign-in email, then enter that address and its six-digit code. While fewer than two recipient emails exist, login requires the registered email plus the shared code. At two or more recipients, the email field disappears and the shared six-digit code alone signs administrators in; recipients are then delivery contacts, not login identities. Existing sessions are retained until their normal expiry or password rotation. Add/remove recipients and rotate the shared code under **Users**. Create a client key under **API keys**, then use `http://localhost:3000/v1` as the OpenAI-compatible base URL.

A local Vercel production build is checked with `pnpm build`.

### Environment variables

See `.env.example` for the full list. Required server settings:

| Variable | Purpose |
|---|---|
| `MONGO_DB_CONNECTION_STRING` | MongoDB connection string |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis for admission, quota, sessions |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Email delivery for shared password |
| `ADMIN_SESSION_SECRET` | Admin cookie signing (32+ random bytes) |
| `STATE_ENCRYPTION_KEY` | AES-256-GCM for provider keys and Responses state (32+ random bytes) |
| `PREVIOUS_STATE_ENCRYPTION_KEY` | Previous encryption key for rotation |
| `CLIENT_KEY_HASH_SECRET` | HMAC for client key hashes (32+ random bytes) |
| `CRON_SECRET` | Daily maintenance cron authorization |
| `JEV_TYPESAFE_API_KEY` | TypeSafe Jev access (optional, for Decisions/System One) |

Provider API keys are **not** set via environment variables. They are added, tested, and encrypted in MongoDB through the **Providers** dashboard page. Each provider has nine numbered slots; slot number defines its independent quota group.

Quota routing starts in `QUOTA_MODE=observe` (default), which records counters without rejecting traffic. Map provider keys to real account/project groups in `QUOTA_CONFIG_JSON`, compare the **Quota** dashboard with the provider console, then switch to `enforce`. See [quota routing](docs/QUOTA_ROUTING.md) for the configuration shape, defaults, and rollout steps.

## OpenAI-compatible API

The gateway exposes:

- `GET /v1/models` and `GET /v1/models/{provider-qualified-model}` — chat models and aliases for keys with `chat` or `responses` scope; embeddings for `embeddings` scope; Jev models with `?type=decision`
- `POST /v1/chat/completions` — SSE and JSON, one choice, supported fields: `model`, `messages`, `stream`, `stream_options.include_usage`, `max_tokens`/`max_completion_tokens`, `temperature`, `top_p`, `stop`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format` (`json_object`/`json_schema`), `reasoning_effort`, `user`, `prompt_cache_key`, `store:false`
- `POST /v1/responses` — stored response retrieval/deletion, input-item listing, streaming
- `GET /v1/models?type=decision` and `POST /v1/decisions` — OpenAI Decisions adapter
- `POST /v1/systemone` and `GET /v1/systemone/models` — TypeSafe native System One

### Model aliases

| Alias | Purpose | Routing |
|---|---|---|
| `fr-fast` | Low latency | Fast models with passed text probe |
| `fr-code` | General coding | ≥200k context, passed text/tools/schema |
| `fr-quality` | Complex reasoning | High-capability models |
| `fr-vision` | Image understanding | Only models with passed vision probe |
| `fr-auto` | Automatic | Deterministic fallback by default; Jev classifier opt-in |

Use a generated `sk-fr-` key as the Bearer token. Model aliases include provider-qualified IDs like `google/gemini-3.5-flash`, `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, `openrouter/nvidia/nemotron-3.5-super-vl:free`, `mistral/ministral-8b-2512`, `matilda/matilda`.

Cursor's built-in Auto selector is different from FreeRouter's `fr-auto`; configure a custom model and the `/v1` base URL in Cursor's OpenAI API key settings. Some Cursor features do not support BYOK or custom providers; deployed Cursor acceptance remains a release gate.

`fr-auto` uses deterministic routing by default (vision → `fr-vision`, high reasoning → `fr-quality`, low reasoning → `fr-fast`, else `fr-code`). Administrators can explicitly enable Jev classification in Settings. The classifier sees a bounded excerpt (≤8,192 chars) of the latest user message and request requirements and consumes TypeSafe credits. It only returns a routing category; the coding answer still comes from a selected LLM.

### Quota admission

Chat Completions and the authenticated Playground pass through the local quota ledger before upstream dispatch. In `enforce` mode, an exhausted configured window returns HTTP 429 with code `quota_exhausted` and `Retry-After`; an upstream provider 429 remains a separate `rate_limit_exceeded` response. Observe mode records the same counters without blocking. The **Quota** dashboard shows groups, limits, live usage, remaining headroom, and reset times. This is local gateway accounting, not provider quota discovery.

## Storage and privacy

- **MongoDB**: Hashed client-key credentials, sanitized operational metadata, configuration, encrypted Responses state
- **Upstash Redis**: Rate windows, in-flight leases, quota request/token counters and settlement markers, short-lived classifier decisions, failed-login throttling
- Quota keys contain provider, group, public model ID, and time-window labels only — no prompt content, client keys, or provider secrets
- Normal request logs omit message content
- Stored Responses payloads are compressed and AES-256-GCM encrypted, owner-scoped with 24-hour logical expiry
- `store:false` does not write a new response record
- The dashboard never displays provider secret values

The temporary content-debugging workflow and complete retention/capacity budgets are not implemented yet. Treat that as a release blocker before production use with sensitive traffic.

## Verification commands

```sh
# Type checking
pnpm typecheck

# Unit and integration tests
pnpm test

# Quota Redis integration tests (requires local redis-server)
pnpm test:quota:redis

# Production build
pnpm build

# Live model smoke test (uses local .env credentials)
pnpm smoke:models

# Matilda-specific smoke test
pnpm smoke:matilda

# Mistral-specific smoke test
MISTRAL_SMOKE_MODEL=mistral/ministral-8b-2512 pnpm smoke:mistral

# TokenHarbor smoke test
pnpm smoke:tokenharbor

# Deployed smoke test (set FREEROUTER_BASE_URL)
pnpm smoke:deployment
```

## Deployment

Deploy as a Node.js 24 Vercel application with Fluid Compute and a 300-second function duration. Set the required server variables in the Vercel project. Configure the maintenance cron secret as `CRON_SECRET`, then run the daily job in `vercel.json`. Provider API keys are encrypted in MongoDB and managed on the Providers page; keep preview deployments isolated from production databases and client data. Follow the Vercel Hobby limits for function duration and daily cron scheduling.

### Vercel configuration

- Framework: Next.js
- Build command: `pnpm build`
- Output directory: `.next` (default)
- Node.js version: 24.x
- Function max duration: 300s
- Fluid Compute: enabled

### Database access

The current Vercel Hobby deployment uses changing outbound IPs. The Atlas project therefore has a `0.0.0.0/0` IP access entry labelled `Vercel Hobby outbound IPs (FreeRouter)`. This admits connections from any IPv4 source; TLS and database authentication still apply. Remove this broad rule when moving to a deployment with stable egress, and replace it with the exact Vercel egress addresses. The current Atlas application user has the built-in `atlasAdmin` role across all resources, which is broader than FreeRouter needs. The app database is `freerouter`; reduce that user to `readWrite` on only `freerouter` (or create a dedicated least-privilege user and update the server-only connection string) before using this open network rule for sensitive production data.

## Documentation

- [API and routing contracts](docs/API_CONTRACTS.md) — Wire boundary, provider constraints, request/response shapes
- [Quota routing](docs/QUOTA_ROUTING.md) — Configuration, groups, limits, accounting, verification, rollout
- [Operations guide](docs/OPERATIONS.md) — Service layout, environment, live smoke, credential management, health, deployment
- [Implementation status](docs/IMPLEMENTATION_STATUS.md) — Area-by-area status, evidence, release gates, blockers
- [Embeddings](docs/EMBEDDINGS.md) — Enabled models, dimensions, retrieval modes, probe record
- [Mistral AI integration](docs/MISTRAL.md) — Access, limits, observed capabilities, gateway smoke
- [Provider assets](docs/PROVIDER_ASSETS.md) — Local logo files and sources

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, PR titles, labels, ownership, checks, and disclosure requirements. Repository rules are in [AGENTS.md](AGENTS.md).

## License

Proprietary. See repository maintainers for terms.