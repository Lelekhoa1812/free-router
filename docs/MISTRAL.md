# Mistral AI integration

Reviewed 11 November 2026. This is a dated snapshot, not a guarantee of availability or price.

## Access and limits

[Mistral's Free mode](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key) includes API usage for evaluation. The public documentation does not establish a universal credit balance or a single model-by-model free quota. Consult the account's [usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) and billing settings. Limits apply per organization and model; several API keys may share the same allowance. Paid usage, where enabled, depends on the account configuration. FreeRouter does not query account balances or prevent paid usage.

On 5 November, an authenticated model-list request returned 55 IDs. This proves listing access only. `ministral-3b-2512`, `ministral-8b-2512`, and `ministral-14b-2512` produced real responses. `mistral-small-2603` and its latest alias returned HTTP 429, including a retry, with no retry or rate-limit headers; the reason and scope of the limit are unknown. The listed `mistral-large-4` was not called. The requested `devstral-latest`, `devstral-small-latest`, and `mistral-large-latest` IDs were not in that account's model listing.

The list advertised 131,072 context tokens for 3B, 262,144 for 8B and 14B, and 262,144 for Small 4. The 3B model is below the 200,000-token `fr-code` policy. Even for the 8B and 14B models, Cursor may assume a different context limit for a custom model, and provider or account limits can be lower than the catalog claims. Model listing and a short prompt do not establish a usable full context window.

## Observed capabilities and routing

Real OpenAI TypeScript SDK probes against Mistral's direct endpoint passed streaming, named function calls and tool continuation, strict response schema, a small coding task, and a simple image question for the pinned 8B and 14B models. The 8B model additionally passed `auto` and `required` tool choice and strict tool schema. On 3B, a request with the OpenAI `developer` role returned HTTP 422. See [API_CONTRACTS.md](API_CONTRACTS.md) for the gateway's role handling.

The gateway places 8B and 14B at the end of `fr-fast` and `fr-vision`. A direct coding sample gave both a pass on a palindrome task but missed cases in a recursive numeric sum task, so neither is included in `fr-code`. Small 4 remains experimental after 429 responses. On 5 November, production commit `5d47ef8` passed the gateway smoke below for both pinned models, including the optional image test and temporary-key cleanup. These are bounded probes rather than comprehensive quality or production certification. Actual Cursor UI agent and tool-loop acceptance remains open.

## Small comparative coding sample

Two JavaScript tasks were sent directly to individual providers with temperature zero and a 500-token output limit. The returned `solve` function was executed with a one-second timeout against five palindrome cases or four nested-sum cases. One call per task is too small for a reliable ranking; network latency, output formatting, provider load and chosen prompt can change the result.

| Binding | Palindrome | Nested sum | Direct elapsed times |
| --- | --- | --- | --- |
| Mistral Ministral 3 8B | 5/5 cases | 3/4 cases | 913 ms, 2,585 ms |
| Mistral Ministral 3 14B | 5/5 cases | 2/4 cases | 1,049 ms, 1,354 ms |
| NVIDIA Laguna XS 2.1 | passed | passed | 979 ms, 795 ms |
| OpenRouter Nemotron 3 Nano Omni | passed | passed | 329 ms, 364 ms |
| Google Gemini 3.5 Flash | failed harness check | failed harness check | 4,403 ms, 4,834 ms |

Google Gemini 3.1 Flash-Lite passed one task in 4,802 ms and timed out after 60 seconds on the other; the task order was not retained. Other sampled OpenRouter/NVIDIA responses had non-string content and were not reliably scored. A recheck did not retain the response content, so these results do not establish model quality or a gateway failure. The test did not measure full agent tasks, long context, security, sustained throughput, or token cost.

## Gateway smoke

With an authorized local environment and the target's MongoDB and encryption settings, run:

```sh
FREEROUTER_BASE_URL=https://free-router-olive.vercel.app MISTRAL_SMOKE_MODEL=mistral/ministral-8b-2512 pnpm smoke:mistral
```

The script reads the existing admin access state, creates a temporary scoped client key, checks discovery, streaming, streamed tools and continuation, strict schema, developer-only instructions, Responses streaming and stored Responses retrieval/deletion, then revokes and deletes the key. Optionally set `MISTRAL_SMOKE_IMAGE` to a PNG containing a blue circle and a red square to run the vision check. It prints sanitized pass/fail results, not credentials. This smoke makes real model requests and may consume the account's included or paid usage.
