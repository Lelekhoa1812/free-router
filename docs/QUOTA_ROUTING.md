# Quota routing

Last reviewed: 4 November 2026.

FreeRouter keeps a local quota ledger in Upstash Redis. It estimates each request's token cost, reserves that estimate atomically, and settles the reservation from provider-reported usage when the response completes. The ledger is a gateway admission layer; it is not a live feed from Google, NVIDIA, OpenRouter, Matilda, ZenMux, or OrcaRouter.

## Modes

Set `QUOTA_MODE` to one of:

| Mode | Behavior |
|---|---|
| `off` | No ledger reads or writes. Requests go straight to admission and upstream dispatch. |
| `observe` | Default. Counters are written and the admin **Quota** page shows live usage, but no request is rejected by this ledger. |
| `enforce` | A request that would exceed a configured request or token window is rejected with HTTP 429, code `quota_exhausted`, and `Retry-After`. |

An invalid `QUOTA_MODE` produces a configuration warning and leaves the mode from `QUOTA_CONFIG_JSON`, or `observe` when that is absent. A malformed `QUOTA_CONFIG_JSON` falls back to safe defaults in observe mode. In `enforce`, an invalid configuration fails closed: the request is not sent upstream.

## Router groups

The public aliases are ordered fallback tiers in `src/lib/models/catalog.ts`. `fr-fast`, `fr-code`, `fr-quality`, and `fr-vision` each include the currently ready models appropriate to that route. `fr-auto` first chooses one of those categories (using deterministic rules unless the optional Jev classifier is enabled), then uses that category's tier. A model may appear in multiple groups so it remains available for different request types.

At request time, the gateway removes candidates that are not ready, lack a passed text probe, have no healthy configured credential, or do not satisfy the request's verified tool, schema, reasoning, or vision requirements. Alias order is preference, not a promise that every candidate can serve every request. In particular, `fr-vision` contains only models with a passed vision probe; a model name containing “VL” is not enough evidence to route images to it.

The catalog tests require every ready text model to appear in at least one Auto category, require each category to retain a routable catalog candidate, and ensure every vision tier member has a passed vision capability. Experimental and unavailable models remain out of these groups until their readiness status changes through verified evidence.

`fr-code` also requires a catalog context window of at least 200,000 tokens, matching Cursor's documented normal context window ([Cursor Models](https://docs.cursor.com/advanced/models)). Cursor's custom OpenAI-compatible models may use an assumed context window that the provider does not support, so this tier excludes providers without a verified context size and models below 200k. Matilda remains available in other applicable tiers; it is excluded from `fr-code` because its gateway request limit is 16,000 characters per message and its token context limit is undocumented.

## Configuration

`QUOTA_CONFIG_JSON` is optional. Empty values use the defaults below. The top-level object accepts only `mode`, `groups`, and `providers`; unknown properties are rejected.

```json
{
  "mode": "observe",
  "groups": [
    { "id": "google-project-a", "provider": "google", "slots": [1, 2, 3], "label": "Google project A" },
    { "id": "google-project-b", "provider": "google", "slots": [4, 5, 6], "label": "Google project B" }
  ],
  "providers": {
    "google": {
      "scope": "model",
      "timeZone": "America/Los_Angeles",
      "limits": { "rpm": 5 },
      "models": {
        "google/gemini-3.6-flash": { "rpd": 50 }
      }
    },
    "openrouter": {
      "scope": "group",
      "timeZone": "UTC",
      "limits": { "rpm": 20, "rpd": 50 }
    }
  }
}
```

Each provider slot is the number in its environment variable, for example `GEMINI_API_KEY_2` is Google slot `2`. Every configured provider has nine slots. Any slot not named in a group is appended to that provider's `default` group; if no `default` group exists, one is created. A slot cannot appear in two groups, and group IDs must be unique within a provider.

A group is a quota boundary, not a UI label. Put keys that share a real provider quota in the same group:

- **Google AI Studio** quotas apply per project. Keys from different projects belong in different groups. Do not mix projects in one group merely to make the dashboard look simpler.
- **OpenRouter free models** have an account-wide free-model daily request limit. Its default `group` scope therefore has one counter for all free models; configuring per-model `models` entries does not create separate upstream limits.
- **NVIDIA NIM** does not publish a per-model contract in this repository. `rpm: 40` is a conservative local guard, not a provider entitlement.
- **Matilda** has request-size limits rather than a documented free-tier daily quota. `rpm: 5` is a local safety guard.

`scope` is `model` or `group`. `model` keeps separate counters for each public model ID in the group. `group` keeps one account-wide counter and is appropriate when the provider bills or limits across the whole account.

`timeZone` controls the daily reset boundary and accepts an IANA time zone. The default Google boundary is `America/Los_Angeles`; the others default to `UTC`. Daylight-saving transitions are handled by calendar-day boundaries rather than a fixed 24-hour TTL.

`limits` accepts `rpm`, `rpd`, `tpm`, and `tpd` as non-negative integers. Zero or an absent value means that window is unconfigured and only observed. Per-model `models` entries merge over the provider limits when `scope` is `model`. Under `group` scope the shared counter uses only the provider limits, and the dashboard warns that per-model entries are ignored. Model keys are the public gateway IDs, for example `google/gemini-3.6-flash` (not the upstream-only name).

### Defaults

| Provider | Scope | Day boundary | Default limits |
|---|---|---|---|
| Google AI Studio | `model` | `America/Los_Angeles` | `rpm: 5` |
| NVIDIA NIM | `model` | `UTC` | `rpm: 40` |
| OpenRouter | `group` | `UTC` | `rpm: 20`, `rpd: 50` |
| Matilda (Maincode) | `model` | `UTC` | `rpm: 5` |
| Mistral AI | `model` | `UTC` | `rpm: 5` |

Mistral's [usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) are set per organization and model; inspect the account's current limits rather than assuming that separate keys have independent quotas. Free mode offers included usage for evaluation, but the public documentation does not establish a universal credit amount or per-model allowance. The five-RPM FreeRouter default is a local guard, not a provider promise, and the default `observe` mode does not enforce it. Configure the actual limits and use `enforce` if local admission is required. A 429 was observed during testing without a retry header.

## Accounting

1. The gateway estimates prompt tokens from message text, image parts, tools, and message overhead. It reserves the smaller of the caller's requested output ceiling, the model's advertised maximum, and 8,192 tokens; the default reserve is 4,096.
2. One Redis Lua script checks the per-minute and provider-local-day request windows plus the token windows. In enforce mode a failed check does not increment counters. In observe mode the attempt is recorded and allowed.
3. The reservation is settled once per attempt. Provider-reported usage wins; otherwise the gateway estimates from visible content and tool-call arguments. A stream that fails or is cancelled before usable output releases its token reservation. A dispatched attempt remains counted in the request windows, because it may already have reached the provider.
4. Retries and credential rotation create separate attempts. They therefore consume separate request-window entries, while the token reservation is reconciled per attempt.
5. Redis keys contain only provider, group, public model ID, day or minute, and a settlement marker. Prompt content, client keys, and provider secrets are not stored in these keys.

The ledger is intentionally conservative when a process dies before settlement: the estimated tokens remain charged rather than undercounting usage.

## Verification

`pnpm test:quota:redis` starts a temporary local `redis-server` and a small Upstash-compatible HTTP fixture, then runs the real reserve/settle Lua against concurrent requests. It covers request-window and token-window contention, idempotent duplicate settlement, failed-attempt release, and a race between two independent worker processes sharing one Redis window. Local runs need `redis-server` and `redis-cli` on `PATH`; set `QUOTA_REDIS_TEST_PORT` to use an existing Redis instead. The normal `pnpm test` excludes this suite, while CI runs it against a Redis 7.2.5 service container. It uses a temporary or isolated database and never points at the hosted Upstash instance.

## Admin visibility

The dashboard **Quota** page reads `GET /api/admin/quota`. It requires an admin session and returns `Cache-Control: no-store`. It shows the current mode, per-provider groups, assigned slots, configured limits, live request/token counters, remaining headroom, reset time, and configuration warnings.

Redis failure produces an explicit unavailable projection rather than invented zero usage. Limits remain visible, but counters and remaining values are marked unavailable.

This first version is read-only. Policy editing remains an environment-variable operation.

## Errors and retry behavior

| Situation | Response |
|---|---|
| Local request or token window exhausted in enforce mode | HTTP 429, code `quota_exhausted`, bounded `Retry-After` |
| Upstream provider returns 429 | Existing upstream classification, code `rate_limit_exceeded` where applicable |
| Streaming request denied before dispatch | SSE error frame with code `quota_exhausted`; no successful `[DONE]` frame |
| Observe mode with Redis unavailable | Request continues; admin projection marks counters unavailable |
| Enforce mode with Redis unavailable or invalid config | Request is not dispatched; the gateway fails closed |

## Limitations

- The ledger sees only traffic through this gateway. Calls made directly to a provider, or through another gateway, are invisible.
- Provider quota APIs and billing consoles are not polled. Operator-declared limits must be reviewed when provider terms change.
- There is no durable reservation journal or Redis epoch recovery yet. A Redis flush, eviction, or outage can undercount an enforcement window.
- Token estimates are approximate, especially for images, tools, and provider-specific reasoning tokens. Provider-reported usage is preferred whenever it is present.
- Minute windows are fixed calendar-minute buckets, not a sliding 60-second window. A burst that straddles a minute boundary can briefly exceed the nominal per-minute limit. Keep enforced limits below the provider ceiling when boundary bursts matter.
- A failed request still counts as an attempt in request windows after dispatch. This can be more conservative than a provider's own accounting.
- Quota counters do not identify a credential secret. Removing or rotating a slot does not reset counters for its group or model.

## Rollout

1. Map each provider group to the real account or project boundary. Keep Google keys from different projects in different groups.
2. Start with `QUOTA_MODE=observe` and let normal traffic populate the **Quota** page for at least one daily reset.
3. Compare the dashboard counters with the provider console, then enter the current limits in `QUOTA_CONFIG_JSON`.
4. Switch to `QUOTA_MODE=enforce` and watch for `quota_exhausted` responses and their `Retry-After` values.
5. Use the provider console as the final source of truth. If provider terms change, update the configuration and repeat the observe step.
