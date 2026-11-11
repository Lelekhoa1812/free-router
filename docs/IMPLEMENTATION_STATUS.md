# Implementation status and release gates

This map keeps the implementation reviewable against the FreeRouter product plan. A check means the basic code path exists; it does not imply production certification.

Last reviewed: 11 November 2026.

| Area | Status | Evidence / remaining gate |
|---|---|---|
| Next.js application, TypeScript, Vercel Node routes | Implemented | `src/app`, `vercel.json`, build check |
| MongoDB only durable store | Implemented foundation | Mongo client pool and indexes exist; storage budget accounting and recovery remain |
| Upstash atomic minute admission and expiring concurrency leases | Implemented foundation | Lua admission covers global/client/provider/model scopes; the quota ledger adds request/token windows and settlements. Redis epoch recovery and a durable reservation journal remain |
| Quota-aware routing and admin visibility | Implemented foundation, observe by default | `src/lib/quota/*`; atomic reserve/settle for Chat and Playground, provider group/model scopes, per-minute and provider-local-day windows, `quota_exhausted` errors, and a read-only **Quota** dashboard. Unit tests cover config, DST resets, estimates, settlement, routing integration, and admin projection. Provider quota discovery, real Redis fault tests, and operator configuration UI remain |
| Email-based dashboard access, Users page, signed cookie, failed-login throttle | Implemented and covered by mocked route/session tests | Shared six-digit code encrypted in MongoDB; sender mailbox bootstrap; deployed SMTP delivery confirmed |
| Generated client keys, scope/model enforcement, revocation | Implemented foundation | `/api/admin/keys`; full limits/expiry/audit/cascade integration tests remain |
| Google, NVIDIA, OpenRouter seed inventory | Implemented snapshot | `src/lib/models/catalog.ts`; daily discovery and full model/capability certification remain |
| Router group coverage | Implemented and unit-tested | All ready text models are assigned to at least one `fr-fast`, `fr-code`, or `fr-quality` fallback tier selected by `fr-auto`; `fr-code` requires a documented context window of at least 200k tokens to match Cursor's normal context window. `fr-vision` contains only models with a passed vision probe. Alias membership remains subject to live credential health and per-request capability filtering |
| Matilda (Maincode) provider | Direct upstream and local gateway certified for supported Chat workflows | Real OpenAI TypeScript SDK calls on 4 November 2026 passed upstream model discovery, streamed Chat, JSON mode, strict `json_schema`, system/developer messages, streamed native tools and tool continuation. The same SDK passed against the local FreeRouter gateway for streamed and non-streamed Chat, tool continuation, schema, JSON mode, Responses streaming, and stored retrieval/deletion. Inline `image_url` returned upstream HTTP 400; the gateway rejects it. Deployed gateway certification pending |
| Mistral AI provider | Production OpenAI SDK smoke passed for supported workflows; Cursor acceptance pending | On 5 November 2026 the direct Mistral API and the local gateway passed bounded probes for pinned Ministral 3 8B and 14B. The deployed gateway passed discovery, streamed Chat, required tool calls and continuation, streamed tool calls, strict response schema, developer-only messages, image input, Responses streaming and stored retrieval/deletion for both. Small 4 returned 429 and remains experimental. Real Cursor agent and tool-loop acceptance remains open |
| TokenHarbor provider | Configured provider path, not yet probed | `https://tokenharbor.ai/v1` credentials, key migration and a group quota guard (20 RPM, UTC) are configured. The seed model `tokenharbor/deepseek-v4-flash:free` is `experimental`, so the gateway neither lists nor routes it. `pnpm smoke:tokenharbor` probes the upstream directly (discovery, streamed Chat, developer role, tool continuation, strict JSON Schema); promote the model only after that passes, then run `pnpm smoke:tokenharbor --gateway` against the deployment. No live probe has run yet |
| ZenMux provider | Configured provider path, not yet probed | `https://zenmux.ai/api/v1` with standard Bearer auth. Base URL, models, and quota routing configured; live credential authentication, model discovery, and stream acceptance remain |
| OrcaRouter provider | Configured provider path, not yet probed | `https://api.orcarouter.ai/v1` with standard Bearer auth. Base URL, models, and quota routing configured; live credential authentication, model discovery, and stream acceptance remain |
| Chat Completions streaming/nonstreaming | Implemented foundation | `/v1/chat/completions`; provider-specific tests, schema validation, retry/quota classification, local quota reserve/settle tests, and SDK end-to-end suite remain |
| Responses create/store/get/delete/input items | Implemented foundation | `/v1/responses`; encrypted owner-scoped state, incremental streamed text/tool event mapping, token-limit incomplete status, and stream contract tests exist; storage reservations, full SDK event parity, reasoning-envelope continuation, and live SDK round trips remain |
| Jev native System One | Implemented proxy | `/v1/systemone`; schema/cost/fault tests and authenticated smoke suite remain |
| OpenAI Decisions adapter | Implemented adapter | `/v1/decisions`, typed mapping and OpenAI-contract unit tests; live probability mapping/cost tests remain |
| Model-specific embeddings | Implemented and deployed; production OpenAI SDK smoke passed | `POST /v1/embeddings` accepts explicit Google, NVIDIA, or OpenRouter embedding model IDs with a dedicated `embeddings` key scope, same-model credential rotation, Redis admission/quota settlement, non-streaming OpenAI envelope, float/base64 vectors, request limits, and metadata-only logging. On 4 November 2026, the deployed OpenAI TypeScript SDK completed real calls for all 11 currently discoverable embedding models (3 Google, 4 NVIDIA NIM, 4 OpenRouter) and returned valid vectors; admin Playground embedding also passed. Isolated concurrency/fault tests remain |
| Endpoints reference and Playground service tests | Implemented and production service smoke passed | Endpoints page documents Chat/Responses, Decisions/System One, and embeddings with connection examples. Playground has Chat, Decisions, and model-specific embedding tabs. Production smoke on 4 November 2026 passed admin Decisions and embedding proxies; responsive browser/accessibility testing remains |
| Jev internal `fr-auto` classifier | Implemented opt-in path | Settings acknowledgement, confidence/deadline/cache/daily request caps; shared token budgets, Jev outage breaker and behavior tests remain |
| Admin dashboard | Initial operations UI | Storage reports MongoDB data/index and collection footprints against the 512 MB cluster ceiling plus the 320 MB application target; partial samples and stale values are explicit, while Redis memory remains unsampled. Playground reports route, attempts, finish reason, request ID, TTFT, provider-reported usage, approximate post-TTFT output rate, and cancellation. **Quota** reports configured groups, limits, live counters, remaining headroom, resets, and configuration warnings. Charts, full editor actions, quota policy editing, and responsive/accessibility automation remain |
| Temporary debug capture | Not implemented | Must be implemented and tested before any sensitive production traffic |
| Mongo byte budgets, reservations, pressure cleanup | Not implemented | Must not claim storage safeguards until byte accounting and pressure tests pass |
| Daily maintenance | Basic expired-record cleanup | `/api/cron/maintenance`; bounded delete batch only; daily summaries/counter reconciliation/pressure logic remain |
| TypeScript SDK dependency | Added | `openai` pinned by lockfile; SDK network integration tests remain |
| Python SDK compatibility | Not implemented | Add pinned Python SDK runner and test matrix |
| Real quota/concurrency/fault suite | Local Redis integration | Quota ledger and route tests run against mocked Redis; `pnpm test:quota:redis` runs concurrent reserve/settle through an Upstash-compatible HTTP fixture over a real Redis, includes two independent worker processes sharing one window, and uses a Redis 7.2.5 service container in CI. Multi-instance deployment races, eviction, epoch-loss, isolated Mongo concurrency and fault-injection gates remain |
| Live capability certification | Initial probe snapshot only | Re-run bounded current probes; no capability should be considered newly certified from this table |

## Immediate release blockers

1. Add complete field validation and per-profile parameter translation, including Ajv-backed strict JSON Schema validation before output release.
2. Complete pre-output retry policy and provider failure classification for 401/403/404/410/429/5xx across shared credential/model scopes.
3. Implement Redis epoch recovery, Mongo admission and quota reservation journals, interruption-safe quota settlement, storage reservations, index/data budgets, pressure behavior, and cleanup reconciliation.
4. Certify streamed Responses event forwarding against the official SDK, complete encrypted tool continuation metadata, and add provider reasoning-envelope continuation.
5. Add status-changing model/capability certification workflow with authenticated, budgeted probes and explicit activation controls.
6. Add admin CSRF/origin protections, audit all mutations, debug capture with bounded encryption/expiry, and key-state cascade/purge tests.
7. Add official TypeScript and Python SDK contract suites, Redis/Mongo concurrency and fault injection, Playwright responsive/accessibility gates, live model certification, and deployed Cursor acceptance.

## Verification commands

```sh
pnpm typecheck
pnpm test
pnpm build
```

Before a production deployment, run these plus the remaining gates above. Never add live credentials, generated client keys, or `.env` to Git.