import { randomUUID } from "node:crypto";
import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { jsonError, readJson, sameOrigin } from "@/lib/http";
import { EMBEDDING_MODEL_BY_ID } from "@/lib/models/embedding-catalog";
import { getProviderCredentials } from "@/lib/providers/credentials";
import { EmbeddingProviderError, upstreamEmbedding, type CanonicalEmbeddingRequest } from "@/lib/providers/embeddings";
import { checkAdmission, releaseAdmission } from "@/lib/redis";
import { reserveQuota, settleQuota, type QuotaReservation } from "@/lib/quota/ledger";

export const runtime = "nodejs";
export const maxDuration = 300;
const TOTAL_DEADLINE_MS = 280_000;
const ATTEMPT_DEADLINE_MS = 120_000;

function quotaProfile(model: NonNullable<ReturnType<typeof EMBEDDING_MODEL_BY_ID.get>>) {
  return { id: model.id, provider: model.provider, upstream: model.upstream, label: model.label, context: model.maxInputTokens, maxOutput: 0, text: "passed" as const, tools: "unsupported" as const, schema: "unsupported" as const, vision: "unsupported" as const, latency: "standard" as const, status: "ready" as const };
}

export async function POST(request: Request) {
  if (!await getAdminSession()) return jsonError(401, "Unauthorized", "unauthorized");
  if (!sameOrigin(request)) return jsonError(403, "Cross-origin request rejected", "cross_origin_request");
  let body: any;
  try { body = await readJson(request); }
  catch (error) { const message = error instanceof Error ? error.message : "invalid_json"; return jsonError(message === "body_too_large" ? 413 : message === "unsupported_content_type" || message === "unsupported_encoding" ? 415 : 400, message, "invalid_request"); }
  const requestId = `fr_${randomUUID()}`;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError(400, "Request body must be an object", "invalid_request", requestId);
  const model = typeof body.model === "string" ? EMBEDDING_MODEL_BY_ID.get(body.model) : undefined;
  if (!model || model.status !== "ready") return jsonError(404, "Embedding model not found", "model_not_found", requestId);
  const input = body.input;
  const inputs = typeof input === "string" ? [input] : Array.isArray(input) && input.every((value: unknown) => typeof value === "string") ? input : [];
  if (!inputs.length || inputs.length > 64 || inputs.some((value: string) => !value) || inputs.reduce((sum: number, value: string) => sum + value.length, 0) > 256_000) return jsonError(400, "Provide 1 to 64 non-empty text inputs (maximum 256,000 characters)", "invalid_input", requestId, "input");
  if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || body.dimensions < model.dimensions.minimum || body.dimensions > model.dimensions.maximum || (model.dimensions.minimum === model.dimensions.maximum && body.dimensions !== model.dimensions.default))) return jsonError(400, "Dimensions are outside this model's supported range", "invalid_dimensions", requestId, "dimensions");
  if (model.inputType === "required" && body.input_type !== "query" && body.input_type !== "passage") return jsonError(400, "Choose query or passage for this NVIDIA model", "input_type_required", requestId, "input_type");
  if (model.inputType === "unsupported" && body.input_type !== undefined) return jsonError(400, "This model does not accept input_type", "unsupported_parameter", requestId, "input_type");
  const unsupported = Object.keys(body).find((key) => !["model", "input", "dimensions", "encoding_format", "input_type"].includes(key));
  if (unsupported) return jsonError(400, `Unsupported field: ${unsupported}`, "unsupported_parameter", requestId, unsupported);
  if (model.maxInputTokens && inputs.reduce((sum: number, value: string) => sum + Math.ceil(value.length / 3.2), 0) > model.maxInputTokens) return jsonError(400, `Input exceeds the approximate ${model.maxInputTokens}-token limit`, "input_too_large", requestId, "input");

  let credentials: Awaited<ReturnType<typeof getProviderCredentials>>;
  try { credentials = await getProviderCredentials(model.provider); }
  catch { return jsonError(503, "Provider credentials are unavailable", "provider_unavailable", requestId); }
  const db = await getDb();
  const fps = credentials.map((credential) => credential.fingerprint);
  const [healthRows, bindingRows] = await Promise.all([
    db.collection<any>("credential_health").find({ provider: model.provider, fingerprint: { $in: fps } }).toArray(),
    db.collection<any>("embedding_bindings").find({ provider: model.provider, model: model.upstream, fingerprint: { $in: fps } }).toArray(),
  ]);
  const health = new Map(healthRows.map((row) => [row.fingerprint, row]));
  const binding = new Map(bindingRows.map((row) => [row.fingerprint, row]));
  const now = Date.now();
  const candidates = credentials.filter((credential) => {
    const h = health.get(credential.fingerprint), b = binding.get(credential.fingerprint);
    return !h?.paused && h?.authStatus !== "invalid" && !(h?.cooldownUntil && new Date(h.cooldownUntil).getTime() > now)
      && b?.status !== "unavailable" && !(b?.cooldownUntil && new Date(b.cooldownUntil).getTime() > now);
  });
  if (!candidates.length) return jsonError(503, "No healthy credential is available for this model", "model_unavailable", requestId);

  const estimate = Math.max(1, inputs.reduce((sum: number, value: string) => sum + Math.ceil(value.length / 3.2), 0));
  const profile = quotaProfile(model);
  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
  for (const credential of candidates.slice(0, 3)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    const lease = `${requestId}:${model.id}:${credential.slot}`;
    const scopes = ["global", "client:admin-playground", `provider:${model.provider}:account:${credential.slot}`, `binding:${model.id}:${credential.slot}`];
    let admitted = false;
    let reservation: QuotaReservation | undefined;
    let outcome: "completed" | "failed" | "cancelled" | "pre_dispatch" = "failed";
    let usage: { total?: number } | undefined;
    try {
      const admission = await checkAdmission(scopes, lease);
      if (!admission.allowed) return jsonError(429, "Request capacity is temporarily exhausted", "rate_limit_exceeded", requestId, null, admission.retryAfter);
      admitted = true;
      const quota = await reserveQuota({ profile, slot: credential.slot, estimate, attemptId: lease });
      if (!quota.allowed) return jsonError(429, "Provider quota is temporarily exhausted", "rate_limit_exceeded", requestId, null, Math.ceil((quota.retryAfterMs ?? 60_000) / 1_000));
      reservation = quota.reservation;
      const response = await upstreamEmbedding(model, credential, body as CanonicalEmbeddingRequest, AbortSignal.timeout(Math.min(ATTEMPT_DEADLINE_MS, remainingMs)));
      const tokens = response.usage?.total_tokens ?? response.usage?.prompt_tokens;
      usage = { total: typeof tokens === "number" && Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : estimate };
      outcome = "completed";
      const finished = new Date();
      await Promise.all([
        db.collection<any>("credential_health").updateOne({ provider: model.provider, fingerprint: credential.fingerprint }, { $set: { authStatus: "healthy", lastSuccessAt: finished, lastSuccessModel: model.upstream } }, { upsert: true }),
        db.collection<any>("embedding_bindings").updateOne({ provider: model.provider, model: model.upstream, fingerprint: credential.fingerprint }, { $set: { status: "healthy", lastSuccessAt: finished, updatedAt: finished }, $unset: { cooldownUntil: "", reason: "" } }, { upsert: true }),
        db.collection<any>("requests").insertOne({ requestId, requestedModel: model.id, model: model.id, provider: model.provider, protocol: "embeddings", actor: "admin-playground", status: "completed", inputCount: inputs.length, usage, createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) }),
      ]).catch(() => undefined);
      return Response.json({ object: response.object, data: response.data, model: model.id, ...(response.usage ? { usage: response.usage } : {}), request_id: requestId }, { headers: { "cache-control": "no-store", "x-request-id": requestId, "x-freerouter-resolved-model": model.id } });
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        const update: Record<string, unknown> = { lastErrorStatus: error.status, reason: error.code, updatedAt: new Date() };
        if ([401, 402, 403, 404, 410].includes(error.status)) update.status = "unavailable";
        if (error.status === 429 || error.status >= 500) update.cooldownUntil = new Date(Date.now() + 30_000);
        await db.collection<any>("embedding_bindings").updateOne({ provider: model.provider, model: model.upstream, fingerprint: credential.fingerprint }, { $set: update }, { upsert: true }).catch(() => undefined);
        if (error.status === 401) await db.collection<any>("credential_health").updateOne({ provider: model.provider, fingerprint: credential.fingerprint }, { $set: { authStatus: "invalid", lastErrorStatus: 401, updatedAt: new Date() } }, { upsert: true }).catch(() => undefined);
        if (error.status === 429 || error.status >= 500 || [401, 402, 403, 404, 410].includes(error.status)) continue;
        return jsonError(400, "The provider rejected the embedding request parameters for this model", "invalid_embedding_request", requestId);
      }
      return jsonError(503, "Embedding request failed", "provider_unavailable", requestId);
    } finally {
      if (reservation) await settleQuota(reservation, { outcome, usage }).catch(() => false);
      if (admitted) await releaseAdmission(scopes, lease).catch(() => undefined);
    }
  }
  await db.collection<any>("requests").insertOne({ requestId, requestedModel: model.id, provider: model.provider, protocol: "embeddings", actor: "admin-playground", status: "failed", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86_400_000) }).catch(() => undefined);
  return jsonError(503, "No provider credential could complete the embedding request", "provider_unavailable", requestId);
}
