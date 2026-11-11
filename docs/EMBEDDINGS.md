# Embedding provider inventory and probe record

This is the dated evidence for FreeRouter's model-specific `POST /v1/embeddings` surface. Direct provider probes and OpenAI TypeScript SDK probes were run on **4 November 2026** using the configured credentials. No credential values, prompt text, or vectors are recorded here. Availability, free entitlement, dimensions, and rate limits may change; the dashboard's per-binding health is the current operational signal.

Last reviewed: 11 November 2026.

## Enabled models

Every row below completed at least one real embedding call. `Default` is the observed or provider-documented vector width. Google supports output dimensionality reduction; NVIDIA's Nemotron 3 Embed 1B width is fixed. For OpenRouter, zero pricing was confirmed in the authenticated model catalog and returned request usage for the listed `:free` entries.

| FreeRouter model ID | Provider model | Observed output | Retrieval mode | Evidence |
|---|---|---:|---|---|
| `google/gemini-embedding-2` | `gemini-embedding-2` | 768 requested; 3072 default | Not supported | Real OpenAI TypeScript SDK request returned vectors |
| `google/gemini-embedding-2-preview` | `gemini-embedding-2-preview` | 768 requested | Not supported | Real batched API request returned one vector per input |
| `google/gemini-embedding-001` | `gemini-embedding-001` | 3072 default; 768 requested | Not supported | Real API and OpenAI SDK requests returned vectors |
| `nvidia/nvidia/nemotron-3.5-embed-1b` | `nvidia/nemotron-3.5-embed-1b` | 512 requested; 2048 default | Required: `query` or `passage` | Both retrieval modes passed against NIM |
| `nvidia/nvidia/nemotron-3.5-embed-8b` | `nvidia/nemotron-3.5-embed-8b` | 4096 default | Required: `query` or `passage` | Real NIM call returned one vector |
| `nvidia/nvidia/nemotron-3-embed-1b` | `nvidia/nemotron-3-embed-1b` | Fixed 2048 | Required: `query` or `passage` | Real NIM call returned one vector |
| `nvidia/nvidia/llama-nemotron-embed-vl-1b-v2` | `nvidia/llama-nemotron-embed-vl-1b-v2` | 2048 observed | Required: `query` or `passage` | Real text call passed; image input is not exposed in v1 |
| `openrouter/nvidia/nemotron-3.5-embed-1b:free` | `nvidia/nemotron-3.5-embed-1b:free` | 768 requested; 2048 default | Optional: `query` or `passage` | OpenAI TypeScript SDK batch passed; zero-priced listing and request |
| `openrouter/nvidia/nemotron-3.5-embed-8b:free` | `nvidia/nemotron-3.5-embed-8b:free` | 4096 default; 768 accepted | Optional: `query` or `passage` | Real request returned 4096 dimensions; zero-priced listing |
| `openrouter/nvidia/nemotron-3-embed-1b:free` | `nvidia/nemotron-3-embed-1b:free` | Fixed 2048 | Optional: `query` or `passage` | Real call passed; 768-dimension override correctly rejected upstream |
| `openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free` | `nvidia/llama-nemotron-embed-vl-1b-v2:free` | 2048 observed; 768 accepted | Optional: `query` or `passage` | Real text call passed at zero listed price; image input is not exposed in v1 |

The OpenAI TypeScript SDK's `.embeddings.create` call succeeded directly against Google, NVIDIA Nemotron 3.5 Embed 1B, and OpenRouter Nemotron 3.5 Embed 1B. This verifies provider-side OpenAI SDK compatibility for those requests. The FreeRouter adapter has a separate contract and route test suite; production deployment checks must verify that complete path as well.

## Probed but not enabled

NVIDIA's authenticated model listing returned nine embedding/retrieval entries: `nvidia/embed-qa-4`, `nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1`, `nvidia/llama-3.2-nv-embedqa-1b-v1`, `nvidia/llama-nemotron-embed-vl-1b-v2`, `nvidia/nemotron-3-embed-1b`, `nvidia/nemotron-3.5-embed-1b`, `nvidia/nemotron-3.5-embed-8b`, `nvidia/nv-embedqa-mistral-7b-v2`, and `snowflake/arctic-embed-l`. Only the Nemotron entries in the table completed the current real-call checks. The remaining IDs stay out of public discovery until free eligibility, current access, input contract, and output dimensions are verified.

OpenRouter's authenticated embeddings catalog listed 40 models, four tested general Nemotron options at zero price, and a zero-priced `liquid/lfm-2.5-embedding-350m:free` entry. The 350M model is omitted under the modern coding/general quality bar. Other paid entries and image-only/specialized entries are not exposed. A catalog listing or a `:free` suffix alone is not treated as proof of current generation access.

## Adapter and operational rules

- Each request names one concrete embedding ID. There is no embeddings alias, fallback model, or automatic semantic routing.
- Healthy provider credentials can rotate for that same model. Provider/model failures update a binding-specific health record and retry another healthy credential before returning an error.
- Requests are quota-admitted and reserve estimated input tokens; known provider usage settles the reservation, while absent upstream usage uses a clearly internal estimate and remains absent from the public response.
- The adapter validates vector count, ordering, finite numeric values, dimensions, and base64 float32 payloads. It never captures input or vector content in MongoDB request metadata.
- NVIDIA's `input_type` changes retrieval semantics. NIM requires it for the verified models; OpenRouter accepted it but also accepted omission; Google does not accept it.
- `encoding_format` supports float arrays and OpenAI-style base64 float32 output. NVIDIA's non-float quantized embedding modes, modality controls, image payloads, and truncation switches are not part of the public v1 contract.
- Embeddings are not token-streaming responses. The LLM gateway continues to request upstream streaming for chat and Responses where supported.

## Provider documentation

- [Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [embedding guide](https://ai.google.dev/gemini-api/docs/embeddings), [model catalog](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2), and [pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [NVIDIA Nemotron 3.5 Embed 1B API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-embed-1b-infer), [Nemotron 3.5 Embed 8B API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-embed-8b-infer), [Nemotron 3 Embed 1B API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-embed-1b-infer), [Llama Nemotron VL Embed API](https://docs.api.nvidia.com/nim/reference/nvidia-llama-nemotron-embed-vl-1b-v2-infer), and [NIM offerings](https://docs.nvidia.com/nim/large-language-models/latest/about-nim-llm/nim-offerings.html)
- [OpenRouter create embeddings](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings) and [list embedding models](https://openrouter.ai/docs/api/api-reference/embeddings/list-embeddings-models)
