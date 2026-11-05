import { getProviderCredentials, type ProviderCredential } from "@/lib/providers/credentials";
import { MODEL_BY_ID, type ModelProfile } from "@/lib/models/catalog";
import { parseChatRequest } from "@/lib/validation";

export interface CanonicalChat { model: string; messages: unknown[]; stream?: boolean; max_tokens?: number; max_completion_tokens?: number; temperature?: number; top_p?: number; stop?: string | string[]; tools?: unknown[]; tool_choice?: unknown; parallel_tool_calls?: boolean; response_format?: unknown; reasoning_effort?: string; stream_options?: { include_usage?: boolean }; [key: string]: unknown; }

export class ProviderRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

const MATILDA_MAX_BODY_BYTES = 65_536;
const MATILDA_MAX_MESSAGE_CHARS = 16_000;
export function resolveProfile(model: string): ModelProfile | undefined {
  return MODEL_BY_ID.get(model);
}
export function listCredentials(provider: ModelProfile["provider"]) { return getProviderCredentials(provider); }

function buildMatildaBody(profile: ModelProfile, body: CanonicalChat, outputLimit: number | undefined) {
  const filtered: Record<string, unknown> = { model: profile.upstream, messages: body.messages, stream: true };
  if (outputLimit !== undefined) filtered.max_tokens = outputLimit;
  if (["json_object", "json_schema"].includes((body.response_format as any)?.type)) filtered.response_format = body.response_format;
  if (Array.isArray(body.tools) && body.tools.length) filtered.tools = body.tools;
  if (body.tool_choice !== undefined) filtered.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) filtered.parallel_tool_calls = body.parallel_tool_calls;

  for (const message of body.messages as any[]) {
    const content = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
    if (content.length > MATILDA_MAX_MESSAGE_CHARS) {
      throw new ProviderRequestError("Matilda messages must be 16,000 characters or fewer", 400, "message_too_large");
    }
  }
  if (Buffer.byteLength(JSON.stringify(filtered), "utf8") > MATILDA_MAX_BODY_BYTES) {
    throw new ProviderRequestError("Matilda requests must be 65,536 bytes or fewer", 413, "request_too_large");
  }
  return filtered;
}

export function buildProviderChatBody(profile: ModelProfile, body: CanonicalChat) {
  const { store: _store, prompt_cache_key: _affinityHint, ...providerInput } = body;
  const { max_completion_tokens, ...withoutCompletionLimit } = providerInput;
  const outputLimit = max_completion_tokens ?? withoutCompletionLimit.max_tokens;
  const { max_tokens: _legacyLimit, ...providerFields } = withoutCompletionLimit;
  // GLM-5.3-Flash defaults to maximum reasoning effort, which can consume a
  // small output budget before it emits any answer text. Prefer low effort
  // when the caller has not expressed a reasoning preference.
  const glmDefaults = profile.id === "nvidia/z-ai/glm-5.3-flash" && providerFields.reasoning_effort === undefined
    ? { reasoning_effort: "low" }
    : {};
  if (profile.provider === "matilda") return buildMatildaBody(profile, body, outputLimit);
  if (profile.provider === "mistral") {
    const messages = providerFields.messages as any[];
    const hasDeveloper = messages.some((message) => message?.role === "developer");
    const hasSystem = messages.some((message) => message?.role === "system");
    if (hasDeveloper && hasSystem) {
      throw new ProviderRequestError(
        "Mistral cannot preserve separate system and developer instruction priority",
        400,
        "unsupported_parameter",
      );
    }
    // Mistral rejects `developer` on some model families. A developer-only
    // request is mapped to system as the closest supported role; this elevates
    // its priority, so requests that also have a system role are rejected above.
    const mistralMessages = hasDeveloper
      ? messages.map((message) => message?.role === "developer" ? { ...message, role: "system" } : message)
      : messages;
    return { ...providerFields, ...glmDefaults, ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }), model: profile.upstream, messages: mistralMessages, stream: true };
  }
  return { ...providerFields, ...glmDefaults, ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }), model: profile.upstream, stream: true };
}

export async function upstreamChat(profile: ModelProfile, credential: ProviderCredential, body: CanonicalChat, signal?: AbortSignal) {
  const { providers } = await import("@/lib/env");
  const config = providers.find((p) => p.id === profile.provider)!;
  const url = `${config.baseUrl}/chat/completions`;
  const upstreamBody = buildProviderChatBody(profile, body);
  const matilda = profile.provider === "matilda";
  const headers: Record<string, string> = { authorization: `Bearer ${credential.secret}`, "content-type": "application/json", accept: matilda ? "text/event-stream, application/json" : "text/event-stream" };
  if (profile.provider === "openrouter") { headers["HTTP-Referer"] = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://freerouter.local"; headers["X-Title"] = "FreeRouter"; }
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal, cache: "no-store" });
  if (matilda && response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      let completion: any;
      try {
        completion = await response.json();
      } catch {
        return Response.json({ error: { message: "Matilda returned an invalid response", type: "server_error", param: null, code: "upstream_invalid_response" } }, { status: 502, headers: { "cache-control": "no-store" } });
      }
      return completionToSse(completion, profile.upstream);
    }
  }
  return response;
}

function normalizeUsage(usage: any) {
  if (!usage) return undefined;
  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) return usage;
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return usage;
  const prompt = Number(usage.input_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.total_tokens ?? prompt + completion) };
}

export function completionToSse(completion: any, model: string) {
  const choice = completion?.choices?.[0];
  if (!choice) {
    return Response.json({ error: { message: "Matilda returned no choices", type: "server_error", param: null, code: "upstream_invalid_response" } }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const id = typeof completion.id === "string" ? completion.id : `chatcmpl_${Date.now()}`;
  const created = Number.isFinite(completion.created) ? completion.created : Math.floor(Date.now() / 1000);
  const message = choice.message ?? choice.delta ?? {};
  const raw = message.content ?? "";
  const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const events = [`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", ...(content ? { content } : {}) }, finish_reason: null }] })}\n\n`];
  toolCalls.forEach((call: any, index: number) => {
    events.push(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: call.type || "function", function: { name: call.function?.name || "", arguments: call.function?.arguments || "" } }] }, finish_reason: null }],
    })}\n\n`);
  });
  const finishReason = choice.finish_reason || (toolCalls.length ? "tool_calls" : "stop");
  events.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  const usage = normalizeUsage(completion.usage);
  if (usage) events.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
  events.push("data: [DONE]\n\n");
  return new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

export function translateChatRequest(input: unknown): CanonicalChat {
  return parseChatRequest(input);
}
