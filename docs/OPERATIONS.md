# FreeRouter operations guide

Last reviewed: 2 November 2026. Provider catalogs, access, free quotas, and deployed behavior change. Re-run the documented checks before enabling a model or claiming compatibility.

## Service layout

FreeRouter is a Node.js 24 Next.js application deployed to Vercel. `/v1` routes authenticate generated `sk-fr-` client keys and implement OpenAI-shaped model, Chat Completions, and Responses contracts. LLM calls use Google AI Studio, NVIDIA NIM, or OpenRouter credentials held only in server environment variables. TypeSafe Jev is available separately through its native System One endpoint and an OpenAI Decisions adapter. The optional Jev classifier runs only for `fr-auto` after an administrator enables it and acknowledges that a bounded request excerpt is sent to TypeSafe and uses existing account credits.

MongoDB is the only durable database. It stores client-key hashes, provider health and binding observations, request metadata, configuration, and encrypted Responses state. Upstash Redis coordinates request admission, in-flight leases, login throttling, daily Jev request budgets, and short-lived classifier affinity. Redis or MongoDB failure should be treated as an operational outage, not as a reason to skip authentication or quota checks.

## Environment setup

Use `.env.example` as the variable-name reference. Keep `.env` out of Git and use server-only Vercel environment variables in each environment. Configure the numbered provider variables from 1 through 9; blank slots are skipped. Never copy provider secrets into the dashboard, browser, build arguments, or logs.

Required server settings are `MONGO_DB_CONNECTION_STRING`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `STATE_ENCRYPTION_KEY`, `CLIENT_KEY_HASH_SECRET`, and `CRON_SECRET`. `JEV_TYPESAFE_API_KEY` is needed for Jev endpoints and optional classification. Set `MONGODB_DB=freerouter` unless a different database name is intended. Use independent random values for the session, encryption, client-key hash, and cron secrets. During encryption-key rotation, configure the previous state key until records encrypted by it expire.

The dashboard login uses the shared `ADMIN_PASSWORD` and a signed 12-hour cookie. Generated client keys are shown once; the database stores an HMAC hash and a display prefix. Revoke a key before deleting it. Provider secrets remain in environment configuration and are never returned by admin APIs.

## Local development and checks

Use Node.js 24.x and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

The `.nvmrc` and GitHub Actions workflow pin CI to Node 24. The local workspace used Node 26 during the initial implementation, which prints an engine warning; production and CI should use Node 24.

The UI is available at `http://localhost:3000`. Sign in, confirm MongoDB and Redis connectivity under Setup, inspect configured provider slots, then create a client API key. Provider-key retests check authentication/catalog access; they do not certify every model capability.

## Live model streaming smoke test

`pnpm smoke:models` makes one bounded streamed generation request for each model currently designated ready in `scripts/live-model-smoke.mjs`. It loads local `.env`, skips providers with no configured key, chooses the first configured key per provider, sends a tiny prompt with a 128-token ceiling, and checks for visible answer text plus a finish marker. It prints model IDs, credential slot numbers, status, latency, byte counts, and event field names; it never prints credentials or generated answer text. Set `SMOKE_MODEL_TIMEOUT_MS` to change the 120-second per-model deadline, or `SMOKE_MODEL_FILTER` to run a subset by model ID.

A passing smoke test establishes only basic text generation over SSE. It does not certify tools, strict JSON Schema, vision, quota headroom, account independence, Cursor behavior, or long-context limits. Capability claims require the contract tests in [API_CONTRACTS.md](API_CONTRACTS.md) and release evidence described in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

On 2 November 2026, 17 catalog-ready bindings were checked with streaming generation. Six Google models passed, five of six tested NVIDIA models passed, and all five tested OpenRouter models passed. NVIDIA `nvidia/nemotron-3.5-lightning-30b-a3b` returned reasoning-only output without visible assistant content and was removed from the ready/public list. The tested alias order now skips it and continues to Laguna XS. This is a point-in-time check using the first configured credential for each provider; it is not a quota or all-credential certification.

The currently public concrete-model seed set after that check is:

| Provider | Models passing basic streaming text check |
|---|---|
| Google AI Studio | `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash` |
| NVIDIA NIM | `z-ai/glm-5.3-flash`, `nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `poolside/laguna-xs-2.1` |
| OpenRouter | `nvidia/nemotron-3.5-super-vl:free`, `dots-studio/dots-3-note-preview:free`, `cohere/north-mini-code:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |

The full discovered inventory, including experimental, restricted, and failed entries with per-capability observations, is maintained in [`src/lib/models/catalog.ts`](../src/lib/models/catalog.ts). Only `ready` entries with passed text status are candidates for publication, and live credential/model health can remove a candidate from `/v1/models` until it recovers or is retested.

## OpenAI-compatible API

Set the OpenAI-compatible base URL to `https://<deployment>/v1` and supply the generated FreeRouter key as the Bearer token. `GET /v1/models` lists enabled LLM IDs and aliases. Namespaced concrete IDs include `google/<model>`, `nvidia/<model>`, and `openrouter/<model>`; aliases include `fr-fast`, `fr-code`, `fr-quality`, `fr-vision`, and `fr-auto`.

`POST /v1/chat/completions` accepts one choice and explicitly supported fields. The gateway always requests upstream LLM output with `stream: true`, including when a caller requests a normal JSON response. For caller streaming, upstream SSE is normalized and forwarded; for a nonstreaming caller, the gateway assembles the streamed answer before returning JSON. Heartbeats keep open streams active, but Vercel’s maximum function duration remains a hard limit. NVIDIA GLM may have a long time to first content; it remains an available candidate only while actual response text and completion events are produced.

`POST /v1/responses` maps supported input, function tools, text formatting, and reasoning controls through the Chat adapter. By default, it stores an encrypted, client-key-scoped continuation snapshot for 24 hours. `store:false` does not create a new stored response. Stored responses support retrieve, delete, and input-item listing. Current Responses SSE events are emitted after the upstream answer has been assembled; true incremental Responses event forwarding remains a release blocker for latency-sensitive use.

Responses tool calls are returned for the client to execute. FreeRouter never invokes caller-defined tools. Chat resource storage, hosted tools, audio/video, background responses, and unsupported schema/provider options return explicit errors.

Cursor should use the deployment `/v1` URL, a generated key, and a custom model such as `fr-auto` or `fr-code`. Cursor's built-in Auto selection is separate from the FreeRouter alias. Verify a real agent/tool workflow on the deployed Cursor version before relying on it; SDK compatibility alone does not certify Cursor support.

## Jev APIs and credit policy

`POST /v1/systemone` proxies the TypeSafe native request and response shape. `GET /v1/systemone/models` and `GET /v1/models?type=decision` expose Jev model discovery. `POST /v1/decisions` translates OpenAI Decisions predicate, choice, and score questions to native System One and maps typed answers back. Jev does not stream; requests with `stream:true` are rejected. Jev calls use the supplied account and existing credits only. FreeRouter has no balance endpoint, does not add funds, and does not enable top-ups. An insufficient-credit result should be treated as a stop condition until an administrator explicitly retests.

The optional classifier is disabled by default. It consumes one Jev request when called, has a short deadline and daily local request budgets, and falls back to deterministic routing on low confidence or failure. It chooses a routing category, never the coding answer.

## Health and model removal

The seed registry in `src/lib/models/catalog.ts` contains dated research and a `status` used to gate public model exposure. Models marked unavailable, restricted, or experimental are excluded from the concrete public model list and from aliases. Real upstream requests update credential and model-binding health. A 401 quarantines that credential; 404/retirement disables the affected binding; 429 and server errors create cooldowns. A failure in one account should not be treated as proof that the same model is unavailable in all independent accounts.

After a repeatable live smoke failure, verify the exact provider model ID and rerun on another configured key before classifying the model as globally unavailable. Set its catalog status to `unavailable`, record the dated reason, and remove it from routing aliases. Do not treat a shared rate limit or provider outage as permanent model failure. Re-run type-check, tests, build, and model-list tests after catalog edits.

## Vercel deployment and rollback

Link the repository with the authenticated Vercel CLI or Vercel dashboard, select the `free-router` project, and use the Node.js 24 runtime. Configure Fluid Compute and the 300-second maximum duration where the Vercel plan permits it. Set production variables only in the Vercel project; isolate Preview from production credentials and data. The Vercel deployment should have MongoDB network access, Upstash access, and the required provider API egress.

`vercel.json` configures one daily maintenance cron. Protect `/api/cron/maintenance` with `Authorization: Bearer <CRON_SECRET>`. Cron cleans expired operational documents; the full storage pressure accounting and recovery controls described in the implementation plan are not complete yet.

Before production traffic, run CI and live model smoke tests, then run the deployed endpoint checks with an administrator-generated temporary key. Confirm the deployment URL, Node runtime, dependency readiness, model list, Chat streaming, Responses create/stream/retrieve/delete, Jev model discovery, native Jev and Decisions calls where credits permit, error/auth behavior, and Cursor acceptance. Revoke and delete temporary client keys after testing. Record request IDs and sanitized outcomes; never record secrets or prompt content.

For rollback, redeploy the prior known-good Vercel deployment and restore the matching application/catalog revision. Keep state encryption keys compatible with any stored response documents. Recheck health and `/v1/models` after rollback.

## Current operational limits

The first implementation still needs Redis epoch recovery and durable quota reconciliation, MongoDB byte reservations and pressure cleanup, temporary debug capture, complete admin audit/CSRF coverage, real integration and fault suites, Python SDK tests, accessibility/browser tests, and fully incremental Responses streaming. The current dashboard is an operational starting point and does not yet provide the full charting, policy editing, quota management, and certification workflows in the product plan. These are explicit release gaps, not implied by the successful basic model smoke results.
