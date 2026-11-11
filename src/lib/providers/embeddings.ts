import { providers } from "@/lib/env";

export type EmbeddingProvider = "google" | "nvidia" | "openrouter" | "novita" | "hyperbolic" | "inference" | "azure";

export interface EmbeddingProfile {
  id: string;
  provider: EmbeddingProvider;
  upstream: string;
  inputType?: "unsupported" | "optional" | "required";
  dimensions?: { minimum: number; maximum: number; default: number | null };
}

export interface EmbeddingCredential {
  secret: string;
}

/**
 * OpenAI-compatible embedding fields plus explicit extensions exposed by the
 * hosted NVIDIA and OpenRouter embedding APIs. Embeddings are never streamed.
 */
export interface CanonicalEmbeddingRequest {
  model: string;
  input: unknown;
  dimensions?: number;
  encoding_format?: "float" | "base64";
  user?: string;
  input_type?: "query" | "passage";
  modality?: "text" | "image" | "text_image" | Array<"text" | "image" | "text_image">;
  truncate?: "END" | "NONE";
  embedding_type?: "float" | "int8" | "uint8" | "binary" | "ubinary";
  longest_edge?: number;
  stream?: boolean;
}

export class EmbeddingProviderRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "EmbeddingProviderRequestError";
  }
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly providerCode?: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export interface NormalizedEmbeddingResponse {
  object: "list";
  model: string;
  upstreamModel?: string;
  data: Array<{ object: "embedding"; index: number; embedding: number[] | string }>;
  usage?: Record<string, unknown>;
}

const EXTENSION_FIELDS = ["input_type", "modality", "truncate", "embedding_type", "longest_edge"] as const;

export function buildProviderEmbeddingBody(profile: EmbeddingProfile, body: CanonicalEmbeddingRequest) {
  if (body.stream === true) {
    throw new EmbeddingProviderRequestError("Embedding responses do not support streaming", 400, "stream_not_supported");
  }
  if (body.model !== profile.id) {
    throw new EmbeddingProviderRequestError("The requested model does not match the selected embedding profile", 400, "model_mismatch");
  }
  if (body.dimensions !== undefined && profile.dimensions && (body.dimensions < profile.dimensions.minimum || body.dimensions > profile.dimensions.maximum)) {
    throw new EmbeddingProviderRequestError("Requested dimensions are outside the selected model's supported range", 400, "invalid_dimensions");
  }
  if (body.dimensions !== undefined && profile.dimensions && profile.dimensions.minimum === profile.dimensions.maximum && body.dimensions !== profile.dimensions.default) {
    throw new EmbeddingProviderRequestError("The selected model has a fixed output dimension", 400, "invalid_dimensions");
  }
  if (!(typeof body.input === "string" || Array.isArray(body.input)) || (Array.isArray(body.input) && body.input.length === 0)) {
    throw new EmbeddingProviderRequestError("input must be a non-empty string or array", 400, "invalid_input");
  }

  const bodyFields: Record<string, unknown> = { model: profile.upstream, input: body.input };
  if (body.dimensions !== undefined) bodyFields.dimensions = body.dimensions;
  if (body.encoding_format !== undefined) bodyFields.encoding_format = body.encoding_format;
  if (body.user !== undefined) bodyFields.user = body.user;

  for (const field of EXTENSION_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (field === "input_type" && profile.provider === "google") {
      throw new EmbeddingProviderRequestError("input_type is not supported by the Google OpenAI-compatible embeddings endpoint", 400, "unsupported_embedding_parameter");
    }
    if (field === "modality" && profile.provider !== "nvidia") {
      throw new EmbeddingProviderRequestError("modality is supported only by the NVIDIA embeddings endpoint", 400, "unsupported_embedding_parameter");
    }
    if ((field === "truncate" || field === "embedding_type" || field === "longest_edge") && profile.provider !== "nvidia") {
      throw new EmbeddingProviderRequestError(`${field} is supported only by the NVIDIA embeddings endpoint`, 400, "unsupported_embedding_parameter");
    }
    bodyFields[field] = value;
  }

  if (profile.inputType === "required" && !body.input_type) {
    throw new EmbeddingProviderRequestError("This NVIDIA embedding model requires input_type=query or input_type=passage", 400, "input_type_required");
  }
  if (profile.inputType === "unsupported" && body.input_type) {
    throw new EmbeddingProviderRequestError("input_type is not supported by this embedding model", 400, "unsupported_embedding_parameter");
  }

  return bodyFields;
}

/** Build a provider request; no provider supports streaming embedding output. */
function expectedInputCount(input: unknown) {
  if (!Array.isArray(input)) return 1;
  if (input.every((item) => typeof item === "number")) return 1;
  return input.length;
}

function safeProviderCode(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;
}

function packFloat32Base64(values: number[]) {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes.toString("base64");
}

function unpackFloat32Base64(value: string, dimensions?: number) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length % 4 !== 0 || bytes.toString("base64") !== value || (dimensions !== undefined && bytes.length !== dimensions * 4)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = Array.from({ length: bytes.length / 4 }, (_, index) => view.getFloat32(index * 4, true));
  return values.every(Number.isFinite) ? { bytes, values } : undefined;
}

function normalizeEmbeddingResponse(profile: EmbeddingProfile, response: Record<string, unknown>, input: unknown, dimensions?: number, encodingFormat?: "float" | "base64"): NormalizedEmbeddingResponse {
  if (!Array.isArray(response.data)) throw new EmbeddingProviderError("Embedding provider returned an invalid response", 502, "upstream_invalid_response");
  const count = expectedInputCount(input);
  if (response.data.length !== count) throw new EmbeddingProviderError("Embedding provider returned an unexpected number of vectors", 502, "upstream_invalid_response");

  const data = response.data.map((raw, position) => {
    if (!raw || typeof raw !== "object") throw new EmbeddingProviderError("Embedding provider returned an invalid vector", 502, "upstream_invalid_response");
    const row = raw as Record<string, unknown>;
    const index = row.index === undefined ? position : row.index;
    if (!Number.isInteger(index) || index !== position) throw new EmbeddingProviderError("Embedding provider returned invalid vector indices", 502, "upstream_invalid_response");
    const vector = row.embedding;
    if (Array.isArray(vector)) {
      if (!vector.length || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new EmbeddingProviderError("Embedding provider returned an invalid vector", 502, "upstream_invalid_response");
      }
      if (dimensions !== undefined && vector.length !== dimensions) throw new EmbeddingProviderError("Embedding provider returned an unexpected vector dimension", 502, "upstream_invalid_response");
      if (encodingFormat === "base64") return { object: "embedding" as const, index, embedding: packFloat32Base64(vector as number[]) };
      return { object: "embedding" as const, index, embedding: vector as number[] };
    }
    if (typeof vector === "string") {
      const decoded = unpackFloat32Base64(vector, dimensions);
      if (!decoded) {
        throw new EmbeddingProviderError("Embedding provider returned an invalid encoded vector", 502, "upstream_invalid_response");
      }
      if (encodingFormat === "base64") return { object: "embedding" as const, index, embedding: vector };
      return { object: "embedding" as const, index, embedding: decoded.values };
    }
    throw new EmbeddingProviderError("Embedding provider returned an invalid vector", 502, "upstream_invalid_response");
  });

  const model = typeof response.model === "string" ? response.model : undefined;
  const usage = response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
    ? response.usage as Record<string, unknown>
    : undefined;
  return { object: "list", model: profile.id, ...(model ? { upstreamModel: model } : {}), data, ...(usage ? { usage } : {}) };
}

/** Calls a provider's non-streaming embeddings endpoint and normalizes its result. */
export async function upstreamEmbedding(
  profile: EmbeddingProfile,
  credential: EmbeddingCredential,
  body: CanonicalEmbeddingRequest,
  signal?: AbortSignal,
): Promise<NormalizedEmbeddingResponse> {
  const config = providers.find((provider) => provider.id === profile.provider);
  if (!config) throw new EmbeddingProviderRequestError("Unsupported embedding provider", 400, "unsupported_provider");

  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.secret}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (profile.provider === "openrouter") {
    headers["HTTP-Referer"] = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://freerouter.local";
    headers["X-Title"] = "FreeRouter";
  }

  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildProviderEmbeddingBody(profile, body)),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    let providerCode: string | undefined;
    try {
      const errorBody = await response.clone().json() as any;
      providerCode = safeProviderCode(errorBody?.error?.code ?? errorBody?.error?.type ?? errorBody?.code);
    } catch {
      // Do not expose arbitrary upstream response bodies; they can contain input text.
    }
    throw new EmbeddingProviderError(
      "Embedding provider request failed",
      response.status,
      "upstream_embedding_error",
      providerCode,
      response.headers.get("retry-after") ?? undefined,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new EmbeddingProviderError("Embedding provider returned an invalid response", 502, "upstream_invalid_response");
  }
  return normalizeEmbeddingResponse(profile, payload, body.input, body.dimensions ?? profile.dimensions?.default ?? undefined, body.encoding_format);
}
