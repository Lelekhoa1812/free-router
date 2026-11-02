import { randomUUID } from "node:crypto";
import { getAdminSession } from "@/lib/auth/admin";
import { getProviderCredentials } from "@/lib/env";
import { ALIASES, MODEL_BY_ID } from "@/lib/models/catalog";
import { upstreamChat, translateChatRequest } from "@/lib/providers/openai";
import { checkAdmission, releaseAdmission } from "@/lib/redis";
import { getDb } from "@/lib/db";
import { readJson, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

function jsonError(message: string, code: string, status: number) {
  return Response.json({ error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code } }, { status });
}

function event(controller: ReadableStreamDefaultController<Uint8Array>, name: string, data?: unknown) {
  const frame = data === undefined ? `event: ${name}\ndata: {}\n\n` : `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(new TextEncoder().encode(frame));
}

export async function POST(request: Request) {
  if (!await getAdminSession()) return jsonError("Unauthorized", "unauthorized", 401);
  if (!sameOrigin(request)) return jsonError("Cross-origin request rejected", "cross_origin_request", 403);

  let body: any;
  try {
    body = translateChatRequest(await readJson(request));
    const outputLimit = body.max_completion_tokens ?? body.max_tokens;
    if (outputLimit !== undefined && (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 8192)) return jsonError("Output budget must be an integer between 1 and 8,192 tokens.", "invalid_output_budget", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    if (message === "body_too_large") return jsonError("Request body exceeds 4 MiB.", "request_too_large", 413);
    if (message === "unsupported_content_type" || message === "unsupported_encoding") return jsonError("Send an uncompressed application/json request.", "unsupported_media_type", 415);
    return jsonError(message, "invalid_request", 400);
  }

  const candidates = (ALIASES[body.model] || [body.model]).map((id) => MODEL_BY_ID.get(id)).filter((model): model is NonNullable<typeof model> => Boolean(model && model.status === "ready" && model.text === "passed"));
  if (!candidates.length) return jsonError("No eligible model", "model_not_found", 404);

  const requestId = `fr_${randomUUID()}`;
  const startedAt = Date.now();
  const aborter = new AbortController();
  if (request.signal.aborted) aborter.abort(request.signal.reason);
  else request.signal.addEventListener("abort", () => aborter.abort(request.signal.reason), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let isClosed = false;
      const send = (name: string, data?: unknown) => { if (!isClosed) { try { event(controller, name, data); } catch { isClosed = true; aborter.abort(); } } };
      send("status", { message: "Request accepted · preparing an eligible route", requestId });
      const heartbeat = setInterval(() => send("heartbeat", { at: Date.now(), elapsedMs: Date.now() - startedAt }), 10_000);

      void (async () => {
        let attempts = 0;
        let failure = "No healthy provider credential is available.";
        try {
          for (const model of candidates) {
            if (aborter.signal.aborted || isClosed) break;
            const credentials = getProviderCredentials().filter((credential) => credential.provider === model.provider);
            const credential = credentials[0];
            if (!credential) continue;

            const scopes = ["global", "admin:playground", `provider:${model.provider}:account:${credential.slot}`, `binding:${model.id}:${credential.slot}`];
            const lease = `${requestId}:${credential.slot}`;
            let reserved = false;
            try {
              const admission = await checkAdmission(scopes, lease);
              if (!admission.allowed) { failure = `Admission is busy; retry after ${admission.retryAfter}s.`; continue; }
              reserved = true;
              attempts += 1;
              send("status", { message: `Connecting to ${model.label || model.id}`, requestId, resolvedModel: model.id, provider: model.provider, attempt: attempts });
              const upstream = await upstreamChat(model, credential, { ...body, model: model.upstream, stream: true }, aborter.signal);
              if (!upstream.ok || !upstream.body) {
                failure = `Upstream returned HTTP ${upstream.status} for ${model.id}.`;
                await upstream.body?.cancel().catch(() => undefined);
                continue;
              }

              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              let responseText = "";
              let firstTokenAt: number | null = null;
              let finishReason: string | null = null;
              let usage: any;
              const tools = new Map<number, any>();
              send("status", { message: `Streaming from ${model.label || model.id}`, requestId, resolvedModel: model.id, provider: model.provider, attempt: attempts });

              while (!aborter.signal.aborted && !isClosed) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split(/\r?\n\r?\n/);
                buffer = frames.pop() || "";
                for (const frame of frames) {
                  const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"))?.slice(5).trim();
                  if (!line || line === "[DONE]") continue;
                  try {
                    const upstreamEvent = JSON.parse(line);
                    const choice = upstreamEvent.choices?.[0];
                    const delta = choice?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                      firstTokenAt ??= Date.now();
                      responseText += delta;
                      send("delta", { content: delta });
                    }
                    if (choice?.finish_reason) finishReason = choice.finish_reason;
                    if (upstreamEvent.usage) usage = upstreamEvent.usage;
                    for (const call of choice?.delta?.tool_calls || []) {
                      const prior = tools.get(call.index) || { id: call.id || `call_${call.index}`, type: "function", function: { name: "", arguments: "" } };
                      if (call.id) prior.id = call.id;
                      if (call.function?.name) prior.function.name += call.function.name;
                      if (call.function?.arguments) prior.function.arguments += call.function.arguments;
                      tools.set(call.index, prior);
                    }
                  } catch { /* Ignore malformed upstream fragments; the public gateway owns strict parsing. */ }
                }
              }
              await reader.cancel().catch(() => undefined);
              await releaseAdmission(scopes, lease);
              reserved = false;

              if (aborter.signal.aborted || isClosed) break;
              if (!finishReason) {
                failure = "The upstream stream ended before a finish reason was received.";
                const completedAt = Date.now();
                send("failure", { requestId, message: failure, resolvedModel: model.id, provider: model.provider, durationMs: completedAt - startedAt, attempts });
                isClosed = true;
                controller.close();
                return;
              }
              if (!responseText && tools.size === 0) { failure = `The selected route returned no visible text or tool call (${finishReason}).`; continue; }

              const completedAt = Date.now();
              const metrics = {
                requestId,
                requestedModel: body.model,
                resolvedModel: model.id,
                provider: model.provider,
                durationMs: completedAt - startedAt,
                ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
                finishReason,
                usage,
                attempts,
                toolCalls: [...tools.values()],
              };
              void getDb().then((db) => db.collection("requests").insertOne({ requestId, requestedModel: body.model, model: model.id, provider: model.provider, status: "completed", durationMs: metrics.durationMs, usage, createdAt: new Date(startedAt), expiresAt: new Date(completedAt + 7 * 86_400_000) })).catch(() => undefined);
              send("complete", metrics);
              isClosed = true;
              controller.close();
              return;
            } catch (error) {
              failure = error instanceof Error ? error.message : "Provider request failed.";
            } finally {
              if (reserved) await releaseAdmission(scopes, lease).catch(() => undefined);
            }
          }

          if (!aborter.signal.aborted && !isClosed) {
            const completedAt = Date.now();
            void getDb().then((db) => db.collection("requests").insertOne({ requestId, requestedModel: body.model, status: "failed", attempts, createdAt: new Date(startedAt), durationMs: completedAt - startedAt, expiresAt: new Date(completedAt + 7 * 86_400_000) })).catch(() => undefined);
            send("failure", { requestId, message: failure, durationMs: completedAt - startedAt, attempts });
          }
        } catch {
          if (!aborter.signal.aborted && !isClosed) send("failure", { requestId, message: "The playground request could not be completed." });
        } finally {
          clearInterval(heartbeat);
          if (!isClosed) { isClosed = true; try { controller.close(); } catch { /* Client disconnected. */ } }
        }
      })();

      return;
    },
    cancel() { aborter.abort(); },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "x-request-id": requestId } });
}
