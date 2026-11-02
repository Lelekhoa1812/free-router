import { getProviderCredentials } from "@/lib/env";
import { MODEL_BY_ID, type ModelProfile } from "@/lib/models/catalog";

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
  return { ...providerFields, ...(outputLimit === undefined ? {} : { max_tokens: outputLimit }), model: profile.upstream, stream: true };
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
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Request must be a JSON object");
  const x = input as Record<string, unknown>;
  const allowed = new Set(["model","messages","stream","stream_options","max_tokens","max_completion_tokens","temperature","top_p","stop","tools","tool_choice","parallel_tool_calls","response_format","reasoning_effort","user","prompt_cache_key","store"]);
  const unknown = Object.keys(x).find((k) => !allowed.has(k)); if (unknown) throw new Error(`Unsupported request field: ${unknown}`);
  if (typeof x.model !== "string" || !Array.isArray(x.messages) || !x.messages.length) throw new Error("model and non-empty messages are required");
  if (x.n !== undefined && x.n !== 1) throw new Error("Only n=1 is supported");
  if (x.max_tokens !== undefined && x.max_completion_tokens !== undefined) throw new Error("Use only one output-token limit field");
  if (x.store === true) throw new Error("Chat resource storage is unsupported; use Responses API");
  if (x.tools !== undefined && (!Array.isArray(x.tools) || x.tools.length > 128)) throw new Error("tools must contain at most 128 entries");
  if (x.reasoning_effort !== undefined && !["minimal","low","medium","high"].includes(String(x.reasoning_effort))) throw new Error("Unsupported reasoning_effort");
  return x as unknown as CanonicalChat;
}
