import { randomUUID } from "node:crypto";
import { authenticateClient } from "@/lib/auth/client";
import { getDb } from "@/lib/db";
import { hashClientKey } from "@/lib/crypto";
import { jsonError, readJson } from "@/lib/http";
import { EMBEDDING_MODEL_BY_ID, isEmbeddingProvider } from "@/lib/models/embedding-catalog";
import { upstreamEmbedding, EmbeddingProviderError, EmbeddingProviderRequestError, type CanonicalEmbeddingRequest } from "@/lib/providers/embeddings";
import { getProviderCredentials } from "@/lib/providers/credentials";
import { checkAdmission, releaseAdmission } from "@/lib/redis";
import { reserveQuota, settleQuota, type QuotaReservation } from "@/lib/quota/ledger";

export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };
const allowedFields = new Set(["model", "input", "dimensions", "encoding_format", "user", "input_type", "stream"]);
const MAX_INPUTS = 64;
const MAX_TEXT_CHARS = 256_000;
const TOTAL_DEADLINE_MS = 280_000;
const ATTEMPT_DEADLINE_MS = 120_000;

export function parseRetryAfterSeconds(value?: string) {
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) && numeric > 0
    ? numeric
    : (Date.parse(value) - Date.now()) / 1_000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(300, Math.ceil(seconds)) : undefined;
}

function errorResponse(status: number, message: string, code: string, requestId?: string, param: string | null = null, retryAfter = 60) {
  return jsonError(status, message, code, requestId, param, retryAfter);
}

function validateBody(value: unknown): { body?: CanonicalEmbeddingRequest; error?: { message: string; code: string; param: string } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: { message: "Request body must be a JSON object.", code: "invalid_request", param: "body" } };
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowedFields.has(key)) return { error: { message: `Unsupported field: ${key}.`, code: "unsupported_parameter", param: key } };
  if (typeof body.model !== "string" || !body.model) return { error: { message: "model is required.", code: "missing_required_parameter", param: "model" } };
  if (!(typeof body.input === "string" || (Array.isArray(body.input) && body.input.length > 0 && body.input.every((item) => typeof item === "string")))) {
    return { error: { message: "input must be a non-empty string or an array of non-empty strings.", code: "invalid_input", param: "input" } };
  }
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (inputs.length > MAX_INPUTS) return { error: { message: `input supports at most ${MAX_INPUTS} texts per request.`, code: "batch_too_large", param: "input" } };
  if (inputs.some((input) => input.length === 0) || inputs.reduce((sum, input) => sum + input.length, 0) > MAX_TEXT_CHARS) {
    return { error: { message: `input texts must be non-empty and total at most ${MAX_TEXT_CHARS} characters.`, code: "input_too_large", param: "input" } };
  }
  if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || Number(body.dimensions) < 1)) return { error: { message: "dimensions must be a positive integer.", code: "invalid_dimensions", param: "dimensions" } };
  if (body.encoding_format !== undefined && body.encoding_format !== "float" && body.encoding_format !== "base64") return { error: { message: "encoding_format must be float or base64.", code: "invalid_encoding_format", param: "encoding_format" } };
  if (body.user !== undefined && (typeof body.user !== "string" || body.user.length > 256)) return { error: { message: "user must be a string of at most 256 characters.", code: "invalid_user", param: "user" } };
  if (body.input_type !== undefined && body.input_type !== "query" && body.input_type !== "passage") return { error: { message: "input_type must be query or passage.", code: "invalid_input_type", param: "input_type" } };
  if (body.stream !== undefined && typeof body.stream !== "boolean") return { error: { message: "stream must be a boolean.", code: "invalid_stream", param: "stream" } };
  return { body: body as unknown as CanonicalEmbeddingRequest };
}

function tokenEstimate(input: string | string[]) {
  const texts = Array.isArray(input) ? input : [input];
  return Math.max(1, texts.reduce((total, text) => total + Math.ceil(text.length / 3.2), 0));
}

function profileForQuota(model: (typeof EMBEDDING_MODEL_BY_ID extends Map<string, infer T> ? T : never)) {
  return {
    id: model.id,
    provider: model.provider,
    upstream: model.upstream,
    label: model.label,
    context: model.maxInputTokens,
    maxOutput: 0,
    text: "passed" as const,
    tools: "unsupported" as const,
    schema: "unsupported" as const,
    vision: "unsupported" as const,
    latency: "standard" as const,
    status: "ready" as const,
  };
}

export async function POST(request: Request) {
  const requestId = `fr_${randomUUID()}`;
  let parsed: unknown;
  try { parsed = await readJson(request); }
  catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    if (message === "body_too_large") return errorResponse(413, "Request body exceeds 4 MiB.", "request_too_large", requestId);
    if (message === "unsupported_content_type" || message === "unsupported_encoding") return errorResponse(415, "Send an uncompressed application/json request.", "unsupported_media_type", requestId);
    return errorResponse(400, "Request body is not valid JSON.", "invalid_json", requestId);
  }
  const validated = validateBody(parsed);
  if (!validated.body) return errorResponse(400, validated.error!.message, validated.error!.code, requestId, validated.error!.param);
  const body = validated.body;
  const auth = await authenticateClient(request, "embeddings", body.model);
  if ("error" in auth) return errorResponse(auth.error === "invalid_api_key" ? 401 : 403, auth.error === "invalid_api_key" ? "Invalid API key." : "API key cannot access this request.", auth.error || "authentication_error", requestId);
  if (body.stream === true) return errorResponse(400, "Embedding vectors are returned as one response and do not support streaming.", "stream_not_supported", requestId, "stream");

  const model = EMBEDDING_MODEL_BY_ID.get(body.model);
  if (!model || model.status !== "ready") return errorResponse(404, "Embedding model not found.", "model_not_found", requestId, "model");
  if (body.dimensions !== undefined && (body.dimensions < model.dimensions.minimum || body.dimensions > model.dimensions.maximum)) {
    return errorResponse(400, `dimensions must be between ${model.dimensions.minimum} and ${model.dimensions.maximum} for this model.`, "invalid_dimensions", requestId, "dimensions");
  }
  if (body.dimensions !== undefined && model.dimensions.minimum === model.dimensions.maximum && body.dimensions !== model.dimensions.default) {
    return errorResponse(400, `This model returns a fixed ${model.dimensions.default}-dimensional vector.`, "invalid_dimensions", requestId, "dimensions");
  }
  if (model.inputType === "required" && !body.input_type) return errorResponse(400, "This NVIDIA model requires input_type=query or input_type=passage.", "input_type_required", requestId, "input_type");
  if (model.inputType === "unsupported" && body.input_type) return errorResponse(400, "input_type is not supported by this model.", "unsupported_parameter", requestId, "input_type");
  if (!isEmbeddingProvider(model.provider)) return errorResponse(404, "Embedding model not found.", "model_not_found", requestId, "model");

  let credentials: Awaited<ReturnType<typeof getProviderCredentials>>;
  try { credentials = await getProviderCredentials(model.provider); }
  catch { return errorResponse(503, "Provider credentials are temporarily unavailable.", "provider_unavailable", requestId); }
  if (!credentials.length) return errorResponse(503, "No provider credential is currently configured for this model.", "model_unavailable", requestId);
  let db: Awaited<ReturnType<typeof getDb>>;
  let healthRows: any[], bindingRows: any[];
  try {
    db = await getDb();
    [healthRows, bindingRows] = await Promise.all([
      db.collection<any>("credential_health").find({ provider: model.provider, fingerprint: { $in: credentials.map((credential) => credential.fingerprint) } }).toArray(),
      db.collection<any>("embedding_bindings").find({ provider: model.provider, model: model.upstream, fingerprint: { $in: credentials.map((credential) => credential.fingerprint) } }).toArray(),
    ]);
  } catch { return errorResponse(503, "Embedding routing state is temporarily unavailable.", "dependency_unavailable", requestId); }
  const health = new Map(healthRows.map((row) => [row.fingerprint, row]));
  const bindings = new Map(bindingRows.map((row) => [row.fingerprint, row]));
  const now = Date.now();
  const candidates = credentials.filter((credential) => {
    const h = health.get(credential.fingerprint);
    const b = bindings.get(credential.fingerprint);
    return !h?.paused && h?.authStatus !== "invalid" && !(h?.cooldownUntil && new Date(h.cooldownUntil).getTime() > now)
      && b?.status !== "unavailable" && !(b?.cooldownUntil && new Date(b.cooldownUntil).getTime() > now);
  });
  if (!candidates.length) return errorResponse(503, "No healthy credential is currently available for this model.", "model_unavailable", requestId);

  const estimatedTokens = tokenEstimate(body.input as string | string[]);
  if (model.maxInputTokens && estimatedTokens > model.maxInputTokens) return errorResponse(400, `Input exceeds this model's approximate ${model.maxInputTokens}-token limit.`, "input_too_large", requestId, "input");
  const quotaProfile = profileForQuota(model);
  const failures: Array<{ status: number; retryAfter?: number }> = [];
  const start = Date.now();
  const deadlineAt = start + TOTAL_DEADLINE_MS;
  for (const credential of candidates.slice(0, 3)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      failures.push({ status: 504 });
      break;
    }
    const lease = `${requestId}:${model.id}:${credential.slot}`;
    const scopes = ["global", `client:${auth.key._id.toString()}`, `provider:${model.provider}:account:${credential.slot}`, `binding:${model.id}:${credential.slot}`];
    let reserved = false;
    let reservation: QuotaReservation | undefined;
    let outcome: "completed" | "failed" | "cancelled" | "pre_dispatch" = "failed";
    let usage: { total?: number } | undefined;
    try {
      const admission = await checkAdmission(scopes, lease);
      if (!admission.allowed) return errorResponse(429, "Request capacity is temporarily exhausted.", "rate_limit_exceeded", requestId, null, admission.retryAfter);
      reserved = true;
      const quota = await reserveQuota({ profile: quotaProfile, slot: credential.slot, estimate: estimatedTokens, attemptId: lease });
      if (!quota.allowed) {
        await releaseAdmission(scopes, lease); reserved = false;
        return errorResponse(429, "Provider quota is temporarily exhausted.", "rate_limit_exceeded", requestId, null, Math.ceil((quota.retryAfterMs ?? 60_000) / 1_000));
      }
      reservation = quota.reservation;
      const providerBody = body.user ? { ...body, user: hashClientKey(`${auth.key._id.toString()}:${body.user}`) } : body;
      const result = await upstreamEmbedding(model, credential, providerBody, AbortSignal.timeout(Math.min(ATTEMPT_DEADLINE_MS, remainingMs)));
      const rawUsage = result.usage;
      const total = rawUsage && typeof rawUsage.total_tokens === "number" && Number.isFinite(rawUsage.total_tokens)
        ? Math.max(0, Math.round(rawUsage.total_tokens))
        : rawUsage && typeof rawUsage.prompt_tokens === "number" && Number.isFinite(rawUsage.prompt_tokens)
          ? Math.max(0, Math.round(rawUsage.prompt_tokens)) : estimatedTokens;
      usage = { total };
      outcome = "completed";
      const finished = new Date();
      await Promise.all([
        db.collection<any>("credential_health").updateOne({ provider: model.provider, fingerprint: credential.fingerprint }, { $set: { authStatus: "healthy", lastSuccessAt: finished, lastSuccessModel: model.upstream, updatedAt: finished } }, { upsert: true }),
        db.collection<any>("embedding_bindings").updateOne({ provider: model.provider, model: model.upstream, fingerprint: credential.fingerprint }, { $set: { status: "healthy", lastSuccessAt: finished, latencyMs: Date.now() - start, updatedAt: finished }, $unset: { cooldownUntil: "", reason: "" } }, { upsert: true }),
        db.collection<any>("requests").insertOne({ requestId, keyId: auth.key._id.toString(), requestedModel: model.id, model: model.id, provider: model.provider, protocol: "embeddings", status: "completed", inputCount: Array.isArray(body.input) ? body.input.length : 1, usage, latencyMs: Date.now() - start, createdAt: new Date(start), expiresAt: new Date(Date.now() + 7 * 86_400_000) }),
      ]).catch(() => undefined);
      return Response.json({ object: result.object, data: result.data, model: model.id, ...(result.usage ? { usage: result.usage } : {}) }, {
        headers: { ...noStore, "x-request-id": requestId, "x-freerouter-resolved-model": model.id },
      });
    } catch (error) {
      outcome = "failed";
      if (error instanceof EmbeddingProviderRequestError) return errorResponse(error.status, error.message, error.code, requestId);
      if (error instanceof EmbeddingProviderError) {
        const retryAfter = parseRetryAfterSeconds(error.retryAfter);
        failures.push({ status: error.status, retryAfter });
        const nowDate = new Date();
        const update: Record<string, unknown> = { updatedAt: nowDate, lastErrorStatus: error.status, reason: error.code };
        if ([401, 402, 403, 404, 410].includes(error.status)) update.status = "unavailable";
        else if (error.status === 429 || error.status >= 500) update.cooldownUntil = new Date(Date.now() + (error.status === 429 ? Math.min(300_000, Math.max(10_000, (retryAfter ?? 30) * 1_000)) : 30_000));
        await db.collection<any>("embedding_bindings").updateOne({ provider: model.provider, model: model.upstream, fingerprint: credential.fingerprint }, { $set: update }, { upsert: true }).catch(() => undefined);
        if (error.status === 401) await db.collection<any>("credential_health").updateOne({ provider: model.provider, fingerprint: credential.fingerprint }, { $set: { authStatus: "invalid", lastErrorStatus: 401, updatedAt: nowDate } }, { upsert: true }).catch(() => undefined);
        if (error.status === 429 || error.status >= 500 || [401, 402, 403, 404, 410].includes(error.status)) continue;
        return errorResponse(400, "The provider rejected the embedding request parameters for this model.", "invalid_embedding_request", requestId);
      } else if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        failures.push({ status: 504 });
        continue;
      } else {
        return errorResponse(503, "Embedding provider is temporarily unavailable.", "provider_unavailable", requestId);
      }
    } finally {
      if (reservation) await settleQuota(reservation, { outcome, usage }).catch(() => false);
      if (reserved) await releaseAdmission(scopes, lease).catch(() => undefined);
    }
  }
  const status = failures.some((failure) => failure.status === 429) ? 429 : failures.some((failure) => failure.status === 504) ? 504 : failures.some((failure) => failure.status >= 500 || [401, 402, 403, 404, 410].includes(failure.status)) ? 503 : 502;
  const retryAfter = Math.max(1, ...failures.map((failure) => failure.retryAfter || 30));
  const failure = { requestId, model: model.id, provider: model.provider, status, attempts: Math.min(candidates.length, 3), durationMs: Date.now() - start, createdAt: new Date(start), expiresAt: new Date(Date.now() + 7 * 86_400_000) };
  await db.collection<any>("requests").insertOne({ ...failure, protocol: "embeddings", status: "failed" }).catch(() => undefined);
  return errorResponse(status, status === 429 ? "Provider is rate limited for this model." : status === 504 ? "Embedding provider request timed out." : status === 503 ? "Embedding provider is temporarily unavailable." : "Embedding provider request failed.", status === 429 ? "rate_limit_exceeded" : status === 504 ? "gateway_timeout" : status === 503 ? "provider_unavailable" : "upstream_error", requestId, null, retryAfter);
}
