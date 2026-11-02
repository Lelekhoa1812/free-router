# FreeRouter

FreeRouter is a self-hosted, OpenAI-shaped gateway for configured free-tier Google AI Studio, NVIDIA NIM, and OpenRouter models. It also exposes TypeSafe Jev as a separate Decisions API. The dashboard is protected by one shared password; generated `sk-fr-` keys authorize `/v1` API calls.

## Current implementation

This repository contains the runnable Next.js gateway, MongoDB and Upstash clients, server-side admin sessions, generated client credentials, the initial model registry, Chat Completions streaming/nonstreaming, encrypted Responses state, Jev native and Decisions endpoints, and a management dashboard. The model table in `src/lib/models/catalog.ts` is dated probe evidence from the initial investigation. Availability changes; administrators should use the model page and run live checks before enabling a newly discovered model.

The implementation is an initial functional release candidate, not yet a production certification. Detailed missing gates are tracked in [implementation status](docs/IMPLEMENTATION_STATUS.md). In particular, capability results have not yet passed the full adversarial suite, provider quota learning and database storage-pressure accounting are incomplete, Responses currently assemble before emitting their event stream, and deployed Cursor acceptance has not been run.

## Run locally

Use Node.js 24.x and pnpm. Copy `.env.example` to `.env`, fill the provider/database/Redis values, and generate separate high-entropy values for the server secrets. `.env` is ignored by Git. The application only reads `MONGO_DB_CONNECTION_STRING` for MongoDB; it does not use Postgres or Neon.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Sign in with `ADMIN_PASSWORD`, create a client key under **API keys**, then use `http://localhost:3000/v1` as the OpenAI-compatible base URL. A local Vercel production build is checked with `pnpm build`.

The environment variable names and slots are listed in `.env.example`. Provider credentials stay server-side. Blank key slots are skipped. Keep the encryption, session, client-key hash, and cron secrets independent; rotate state encryption with a planned key version migration once existing stored responses need preservation.

## OpenAI-compatible setup

The gateway exposes:

- `GET /v1/models` and `GET /v1/models/{provider-qualified-model}`
- `POST /v1/chat/completions` with SSE and JSON responses
- `POST /v1/responses`, stored response retrieval/deletion, and input-item listing
- `GET /v1/models?type=decision` and `POST /v1/decisions`
- TypeSafe-native `POST /v1/systemone` and `GET /v1/systemone/models`

Use a generated key as the Bearer token. Model aliases include `fr-fast`, `fr-code`, `fr-quality`, `fr-vision`, and `fr-auto`. Cursor's built-in Auto selector is different from FreeRouter's `fr-auto`; configure a custom model and the `/v1` base URL in Cursor's OpenAI API key settings. Some Cursor features do not support BYOK or custom providers; the deployed workflow must pass the acceptance gate before claiming support for that feature.

`fr-auto` uses deterministic routing by default. Administrators can explicitly enable Jev classification in Settings. The classifier sees a bounded excerpt of the latest user message and request requirements and consumes TypeSafe credits. It only returns a routing category; the coding answer still comes from a selected LLM.

## Storage and privacy

MongoDB stores hashed client-key credentials, sanitized operational metadata, configuration, and encrypted Responses state. Upstash Redis stores rate windows, in-flight leases, short-lived classifier decisions, and failed-login throttling. Normal request logs omit message content. Stored Responses payloads are compressed and AES-GCM encrypted and are owner-scoped with a 24-hour logical expiry. `store:false` does not write a new response record.

The temporary content-debugging workflow and complete retention/capacity budgets are not implemented yet. Treat that as a release blocker before production use with sensitive traffic. The dashboard never displays provider secret values.

## Deployment

Deploy as a Node.js 24 Vercel application with Fluid Compute and a 300-second function duration. Set the required server variables in the Vercel project. Configure the maintenance cron secret as `CRON_SECRET`, then run the daily job in `vercel.json`. Keep preview deployments isolated from production provider credentials and databases. Follow the Vercel Hobby limits for function duration and daily cron scheduling.

```sh
pnpm typecheck
pnpm test
pnpm build
```

`pnpm smoke:models` performs a bounded live streaming smoke call for each catalog-ready provider model using local `.env` credentials. After deployment, set `FREEROUTER_BASE_URL` and `ADMIN_PASSWORD`, then run `pnpm smoke:deployment` to verify health, issue a temporary client key, exercise the OpenAI SDK endpoints and visible model routes, and revoke/delete that key automatically. The deployed smoke includes one Jev Decisions call by default; set `SMOKE_JEV=false` to skip it if Jev credits should not be consumed.

See [API and routing contracts](docs/API_CONTRACTS.md), the [operations guide](docs/OPERATIONS.md), and [implementation status](docs/IMPLEMENTATION_STATUS.md) for endpoint behavior, deployment steps, validation procedures, and remaining release gates.
