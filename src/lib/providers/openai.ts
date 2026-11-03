import { getProviderCredentials } from "@/lib/env";
import { MODEL_BY_ID, type ModelProfile } from "@/lib/models/catalog";
import { parseChatRequest } from "@/lib/validation";

export interface CanonicalChat { model: string; messages: unknown[]; stream?: boolean; max_tokens?: number; max_completion_tokens?: number; temperature?: number; top_p?: number; stop?: string | string[]; tools?: unknown[]; tool_choice?: unknown; parallel_tool_calls?: boolean; response_format?: unknown; reasoning_effort?: string; stream_options?: { include_usage?: boolean }; [key: string]: unknown; }
export function resolveProfile(model: string): ModelProfile | undefined {
  return MODEL_BY_ID.get(model);
}
export function listCredentials(provider: ModelProfile["provider"]) { return getProviderCredentials().filter((c) => c.provider === provider); }

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
  return { ...providerFields, ...glmDefaults, ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }), model: profile.upstream, stream: true };
}

export async function upstreamChat(profile: ModelProfile, credential: ReturnType<typeof listCredentials>[number], body: CanonicalChat, signal?: AbortSignal) {
  const { providers } = await import("@/lib/env");
  const config = providers.find((p) => p.id === profile.provider)!;
  const url = `${config.baseUrl}/chat/completions`;
  const upstreamBody = buildProviderChatBody(profile, body);
  const headers: Record<string, string> = { authorization: `Bearer ${credential.secret}`, "content-type": "application/json", accept: "text/event-stream" };
  if (profile.provider === "openrouter") { headers["HTTP-Referer"] = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://freerouter.local"; headers["X-Title"] = "FreeRouter"; }
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal, cache: "no-store" });
  return response;
}

export function translateChatRequest(input: unknown): CanonicalChat {
  return parseChatRequest(input);
}
