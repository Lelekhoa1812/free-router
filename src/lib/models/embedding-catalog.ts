import type { EmbeddingProvider, EmbeddingProfile } from "@/lib/providers/embeddings";

export interface EmbeddingModelProfile extends EmbeddingProfile {
  label: string;
  dimensions: { minimum: number; maximum: number; default: number | null };
  inputType: "unsupported" | "optional" | "required";
  maxInputTokens: number | null;
  freeEvidence: string;
  status: "ready" | "experimental" | "unavailable";
  reason?: string;
}

/**
 * Explicit model-specific embedding bindings. This catalog is deliberately
 * separate from the chat catalog: no `fr-auto` or other alias is valid here.
 */
export const EMBEDDING_MODELS: EmbeddingModelProfile[] = [
  {
    id: "google/gemini-embedding-2",
    provider: "google",
    upstream: "gemini-embedding-2",
    label: "Gemini Embedding 2",
    dimensions: { minimum: 128, maximum: 3072, default: 3072 },
    inputType: "unsupported",
    maxInputTokens: 8192,
    freeEvidence: "A live OpenAI TypeScript SDK embedding request succeeded against Google AI Studio; the official Google catalog marks the text model free tier eligible.",
    status: "ready",
  },
  {
    id: "google/gemini-embedding-2-preview",
    provider: "google",
    upstream: "gemini-embedding-2-preview",
    label: "Gemini Embedding 2 Preview",
    dimensions: { minimum: 128, maximum: 3072, default: 3072 },
    inputType: "unsupported",
    maxInputTokens: 8192,
    freeEvidence: "Real embedding requests returned one 768-dimensional vector per input using a configured Google AI Studio key.",
    status: "ready",
  },
  {
    id: "google/gemini-embedding-001",
    provider: "google",
    upstream: "gemini-embedding-001",
    label: "Gemini Embedding 001",
    dimensions: { minimum: 128, maximum: 3072, default: 3072 },
    inputType: "unsupported",
    maxInputTokens: 2048,
    freeEvidence: "Real embedding request returned a 3072-dimensional vector using a configured Google AI Studio key.",
    status: "ready",
  },
  {
    id: "nvidia/nvidia/nemotron-3.5-embed-1b",
    provider: "nvidia",
    upstream: "nvidia/nemotron-3.5-embed-1b",
    label: "Nemotron 3.5 Embed 1B",
    dimensions: { minimum: 128, maximum: 2048, default: 2048 },
    inputType: "required",
    maxInputTokens: 10240,
    freeEvidence: "NVIDIA’s hosted API catalog labels this a Free Endpoint; real query and passage requests returned 512-dimensional vectors with a configured NIM key.",
    status: "ready",
  },
  {
    id: "nvidia/nvidia/nemotron-3.5-embed-8b",
    provider: "nvidia",
    upstream: "nvidia/nemotron-3.5-embed-8b",
    label: "Nemotron 3.5 Embed 8B",
    dimensions: { minimum: 1, maximum: 4096, default: 4096 },
    inputType: "required",
    maxInputTokens: 10240,
    freeEvidence: "NVIDIA hosted model listing and a real embedding call returned a 4096-dimensional vector with a configured NIM key.",
    status: "ready",
  },
  {
    id: "nvidia/nvidia/nemotron-3-embed-1b",
    provider: "nvidia",
    upstream: "nvidia/nemotron-3-embed-1b",
    label: "Nemotron 3 Embed 1B",
    dimensions: { minimum: 2048, maximum: 2048, default: 2048 },
    inputType: "required",
    maxInputTokens: 10240,
    freeEvidence: "NVIDIA hosted model listing and a real embedding call returned a 2048-dimensional vector with a configured NIM key.",
    status: "ready",
  },
  {
    id: "openrouter/nvidia/nemotron-3.5-embed-1b:free",
    provider: "openrouter",
    upstream: "nvidia/nemotron-3.5-embed-1b:free",
    label: "Nemotron 3.5 Embed 1B (OpenRouter Free)",
    dimensions: { minimum: 128, maximum: 2048, default: 2048 },
    inputType: "optional",
    maxInputTokens: 10240,
    freeEvidence: "OpenRouter’s authenticated embeddings catalog reports zero prompt, completion, and request prices; a batched live request returned 768-dimensional vectors.",
    status: "ready",
  },
  {
    id: "openrouter/nvidia/nemotron-3.5-embed-8b:free",
    provider: "openrouter",
    upstream: "nvidia/nemotron-3.5-embed-8b:free",
    label: "Nemotron 3.5 Embed 8B (OpenRouter Free)",
    dimensions: { minimum: 128, maximum: 4096, default: 4096 },
    inputType: "optional",
    maxInputTokens: 10240,
    freeEvidence: "OpenRouter’s authenticated embeddings catalog reports zero prompt, completion, and request prices; a live request returned a 4096-dimensional vector.",
    status: "ready",
  },
  {
    id: "openrouter/nvidia/nemotron-3-embed-1b:free",
    provider: "openrouter",
    upstream: "nvidia/nemotron-3-embed-1b:free",
    label: "Nemotron 3 Embed 1B (OpenRouter Free)",
    dimensions: { minimum: 2048, maximum: 2048, default: 2048 },
    inputType: "optional",
    maxInputTokens: 10240,
    freeEvidence: "OpenRouter’s authenticated embeddings catalog reports zero prompt, completion, and request prices; a live call returned a 2048-dimensional vector.",
    status: "ready",
  },
  {
    id: "nvidia/nvidia/llama-nemotron-embed-vl-1b-v2",
    provider: "nvidia",
    upstream: "nvidia/llama-nemotron-embed-vl-1b-v2",
    label: "Llama Nemotron Embed VL 1B v2",
    dimensions: { minimum: 128, maximum: 2048, default: 2048 },
    inputType: "required",
    maxInputTokens: 8192,
    freeEvidence: "A real NVIDIA hosted text-embedding call returned a 2048-dimensional vector with input_type=passage; the initial FreeRouter endpoint exposes text only.",
    status: "ready",
  },
  {
    id: "openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free",
    provider: "openrouter",
    upstream: "nvidia/llama-nemotron-embed-vl-1b-v2:free",
    label: "Llama Nemotron Embed VL 1B v2 (OpenRouter Free)",
    dimensions: { minimum: 128, maximum: 2048, default: 2048 },
    inputType: "optional",
    maxInputTokens: 8192,
    freeEvidence: "OpenRouter’s authenticated embeddings catalog reports zero prices; a real text call returned a 2048-dimensional vector. This endpoint is text-only in FreeRouter v1.",
    status: "ready",
  },
];

export const EMBEDDING_MODEL_BY_ID = new Map(EMBEDDING_MODELS.map((model) => [model.id, model]));

export function publicEmbeddingModels(now = Math.floor(Date.now() / 1000)) {
  return EMBEDDING_MODELS.filter((model) => model.status === "ready").map((model) => ({
    id: model.id,
    object: "model",
    created: now,
    owned_by: model.provider,
    task: "embeddings",
    dimensions: model.dimensions,
    input_type_supported: model.inputType !== "unsupported",
    input_type_required: model.inputType === "required",
  }));
}

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return value === "google" || value === "nvidia" || value === "openrouter";
}
