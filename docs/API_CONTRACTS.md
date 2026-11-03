# API and routing contracts

This document records the gateway's public wire boundary and provider-specific constraints. OpenAI APIs evolve; the official references below and the pinned SDK used by the compatibility suite are the source of truth for each release.

## Authentication and common behavior

Every `/v1` endpoint takes `Authorization: Bearer sk-fr-…`. Dashboard cookies have no API authority. Client keys are random 256-bit secrets, shown once, and stored as keyed hashes. A key record carries scopes, model restrictions, Jev permission, expiry, and revocation state. Public JSON is `no-store`; errors use an OpenAI-style `error` object, stable code, and request ID. The API body reader enforces a 4 MiB limit.

`/v1/models` advertises enabled chat models and aliases. Jev is omitted unless `?type=decision` is requested. Provider-qualified model IDs preserve the upstream namespace, such as `nvidia/z-ai/glm-5.3-flash` behind the `nvidia/` gateway namespace. An alias can select a different provider only before semantic output begins. A pinned model never silently changes.

## Chat Completions

The canonical request is intentionally narrower than every OpenAI parameter. It accepts `model`, `messages`, `stream`, `stream_options.include_usage`, one of `max_tokens` or `max_completion_tokens`, `temperature`, `top_p`, `stop`, function `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `reasoning_effort`, `user`, `prompt_cache_key`, and `store:false`. Unknown fields are errors. Chat resource storage, `n > 1`, deprecated function fields, audio, hosted tools, and paid service tiers are unsupported.

Input messages are sent in order. Image input is routed only to a profile certified for vision. Tools and strict schema requests are filtered against per-binding capability status. FreeRouter never executes client tools. Tool-call IDs and argument fragments are returned to the client for execution and continuation. Provider-specific structured-output support is not inferred from a provider model catalog flag; each binding needs a successful validation record before automatic routing should advertise it.

The gateway requests upstream streaming even for nonstreaming Chat responses, assembles the response when the client asked for JSON, and normalizes public model IDs, tool indices, finish reasons, and optional usage in SSE. A stream error is an SSE error and is never terminated as a successful `[DONE]` response. The gateway retries only before a response stream is returned; requests already sent to the client are never spliced with another model answer.

## Responses

Responses input is converted into canonical chat messages for the selected model. Supported inputs include text, standard role messages, function calls, and function-call outputs. `instructions` apply to the current turn. `previous_response_id` is owner-scoped, expires after 24 hours, and carries compressed AES-256-GCM encrypted state with authenticated owner/resource/version/expiry data. A valid parent can be read when `store:false`, but the new response is not persisted.

Stored responses can be retrieved, deleted, and listed through `/v1/responses/{id}/input_items`. Foreign, expired, and absent records return the same 404. `conversation`, background execution, automatic truncation, hosted tools, files, audio, WebSockets, and encrypted provider reasoning envelopes are unsupported. For `stream:true`, FreeRouter requests upstream Chat Completions streaming and translates text and tool deltas into Responses events as they arrive. It emits monotonically increasing sequence numbers, preserves output-item order, reports a token-limit finish as `response.incomplete`, and writes stored state before `response.completed`. If the upstream stream fails or required persistence fails after SSE begins, the terminal event is `response.failed`; a partial stream is never reported as completed. Full SDK event parity, reasoning envelopes, and broad live-provider certification remain release gates.

See OpenAI's [Responses guide](https://developers.openai.com/api/docs/guides/migrate-to-responses), [streaming event reference](https://developers.openai.com/api/reference/resources/responses/subresources/streaming-events), and [conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state).

## Jev native and OpenAI Decisions

`POST /v1/systemone` preserves TypeSafe's native `model`, `state`, and named `questions` shape. It accepts `jev-latest` or `jev-preview` and passes the gateway client's key scope while using the server-side TypeSafe key upstream. Experimental assets and box questions are disabled. `GET /v1/systemone/models` discovers names for the authenticated account.

`POST /v1/decisions` accepts OpenAI's `input` plus an ordered `questions` array. Question names are optional and need not be unique; answers return in question order with `name: null` when the caller omitted one. Predicate instructions accept OpenAI text and JSON content parts, while image evidence is rejected because Jev images are not enabled. Predicate questions map to native `noul`; choice options map to opaque internal IDs and are converted back to the caller's original typed values, with unique string/boolean values enforced; score levels preserve order, require a `label`, and return the native fractional expected score. `prompt_cache_key`, `prompt_cache_options`, and `safety_identifier` are accepted for OpenAI compatibility and ignored because Jev exposes no equivalent control. Probability values and confidence remain separate, and `usage` carries the full OpenAI token shape. Responses omit `id` and `object` because OpenAI's Decision object has neither. Upstream failures are translated into the gateway's OpenAI-style `error` envelope. OpenAI defines no `stream` parameter for Decisions; `stream:true` is rejected because Jev cannot stream. Use `jev/jev-latest` or `jev/jev-preview` as the model name.

Jev routing is an internal option for `fr-auto` and never replaces the model answer. It is disabled by default, opt-in requires an administrator acknowledgement, the request excerpt is limited to 8,192 characters, and failures/low confidence fall back to deterministic routing. The gateway does not add credits or top up the TypeSafe account.

See [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [TypeSafe System One](https://docs.typesafe.ai/api/system-one), and [TypeSafe model discovery](https://docs.typesafe.ai/api/list-models).

## Provider profiles and known behavior

Provider model catalog claims and observed generation capabilities are separate. The seed inventory and probe notes live in `src/lib/models/catalog.ts`. Unknown and experimental capabilities are excluded from automatic routing. At present the registry is a dated, checked-in snapshot; authenticated daily catalog discovery, complete probe workflows, capability retest management, and mutation-safe activation need further implementation.

- Google AI Studio exposes an OpenAI-compatible endpoint. Preserve stable prefixes and Google continuation metadata. Its tool streams can omit tool indices or use a misleading stop reason, so stream normalization is required. See [Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).
- NVIDIA hosted NIM uses the OpenAI Chat Completions shape. Heavy models can have long time-to-first-token, so upstream generation streams and gateway heartbeats are enabled. See [NVIDIA LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis).
- OpenRouter uses the OpenAI chat shape and can return a usage-bearing terminal chunk with duplicate finish information. Prompt-cache affinity and provider rate limits are distinct from per-key quota counters. See [OpenRouter model catalog](https://openrouter.ai/api/v1/models), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), and [rate limits](https://openrouter.ai/docs/api_reference/limits).

## Prompt caching and usage

There is no answer cache. Provider prompt/KV caching, gateway binding affinity, Responses state, and the short-lived Jev classifier cache are separate. Provider cache usage is reported only when an upstream supplies it; missing telemetry is unknown, not zero. Do not forward OpenAI-specific explicit cache fields to providers without a certified mapping. Google may use implicit prompt caching; OpenRouter supports provider-specific affinity; hosted NIM cache server settings do not apply to NVIDIA's hosted service.

Usage counts are returned only when the upstream reports them. The gateway does not fabricate token counts. Model catalog context/output values are advertised limits and do not supersede gateway safety limits or account-specific provider quota.
