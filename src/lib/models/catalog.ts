export type Provider = "google" | "nvidia" | "openrouter" | "matilda";
export type CapabilityState = "passed" | "failed" | "unknown" | "unsupported";
export interface ModelProfile {
  id: string; provider: Provider; upstream: string; label: string; context: number | null; maxOutput: number | null;
  text: CapabilityState; tools: CapabilityState; schema: CapabilityState; vision: CapabilityState; latency: "fast" | "standard" | "slow" | "unknown";
  status: "ready" | "experimental" | "unavailable" | "restricted"; reason?: string;
}

const rows: Array<[Provider,string,string,number|null,number|null,CapabilityState,CapabilityState,CapabilityState,CapabilityState,ModelProfile["latency"],ModelProfile["status"],string?]> = [
  ["google","gemini-3-flash-preview","Gemini 3 Flash Preview",1048576,65536,"passed","passed","passed","unknown","standard","unavailable","Two production-gateway SSE attempts on 3 November 2026 returned upstream_unavailable; excluded from public discovery pending successful retest."],
  ["google","gemini-3.1-flash-lite-preview","Gemini 3.1 Flash-Lite Preview",1048576,65536,"passed","passed","passed","unknown","fast","ready"],
  ["google","gemini-3.1-flash-lite","Gemini 3.1 Flash-Lite",1048576,65536,"passed","passed","passed","unknown","fast","ready"],
  ["google","gemini-3.5-flash","Gemini 3.5 Flash",1048576,65536,"passed","passed","passed","unknown","standard","ready"],
  ["google","gemini-3.5-flash-lite","Gemini 3.5 Flash-Lite",1048576,65536,"passed","passed","passed","passed","fast","ready"],
  ["google","gemini-3.6-flash","Gemini 3.6 Flash",1048576,65536,"passed","passed","passed","unknown","standard","ready"],
  ["google","gemini-3.7-flash","Gemini 3.7 Flash",1048576,65536,"unknown","unknown","unknown","unknown","unknown","experimental","Overloaded during the dated probe."],
  ["google","gemini-3.8-flash","Gemini 3.8 Flash",1048576,65536,"unknown","unknown","unknown","unknown","slow","experimental","Overloaded or timed out during the dated probe."],
  ["google","gemma-4-26b-a4b-it","Gemma 4 26B A4B IT",262144,32768,"unknown","passed","passed","unknown","standard","experimental","Inline thought markers require a certified parser."],
  ["google","gemma-4-31b-it","Gemma 4 31B IT",262144,32768,"unknown","unknown","unknown","unknown","slow","experimental","Probe returned a slow/incomplete response."],
  ["google","gemini-flash-lite-latest","Gemini Flash-Lite Latest",1048576,65536,"unknown","unknown","unknown","unknown","unknown","experimental","Floating alias must be resolved and certified before activation."],
  ["nvidia","z-ai/glm-5.3-flash","GLM 5.3 Flash",1048576,32768,"passed","passed","passed","unknown","slow","experimental","Direct NVIDIA streaming passed, but the deployed gateway did not receive response headers within 90 seconds across multiple credentials; hidden pending a successful gateway retest."],
  ["nvidia","deepseek-ai/deepseek-v4.1-flash","DeepSeek V4.1 Flash",1048576,32768,"passed","passed","failed","unknown","slow","experimental","Tool-call protocol needs normalization; schema probe failed."],
  ["nvidia","minimaxai/minimax-m3.1-flash","MiniMax M3.1 Flash",262144,32768,"passed","unknown","unknown","unknown","slow","experimental","Tool/schema probes timed out."],
  ["nvidia","nvidia/nemotron-3.5-super-vl-120b-a12b","Nemotron 3.5 Super VL",1000000,131072,"passed","passed","passed","unknown","fast","ready"],
  ["nvidia","nvidia/nemotron-3-ultra-550b-a55b","Nemotron 3 Ultra 550B",1000000,65536,"passed","passed","passed","unsupported","fast","ready"],
  ["nvidia","nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","Nemotron 3 Nano Omni",256000,65536,"passed","passed","passed","unknown","standard","ready"],
  ["nvidia","poolside/laguna-xs-2.1","Laguna XS 2.1",262144,32768,"passed","passed","passed","unsupported","fast","ready"],
  ["nvidia","stepfun-ai/step-5-preview","Step 5 Preview",1000000,32768,"passed","passed","failed","unknown","standard","experimental","Schema probe returned an empty result."],
  ["nvidia","meta/muse-glimmer-30b","Muse Glimmer 30B",131072,32768,"passed","passed","failed","unknown","standard","experimental","Schema response was empty/incomplete."],
  ["nvidia","google/diffusiongemma-26b-a4b-it","DiffusionGemma 26B A4B IT",262144,32768,"passed","passed","failed","unknown","slow","experimental","Strict schema was ignored; tool probe was slow."],
  ["nvidia","google/gemma-4-31b-it","Gemma 4 31B IT",262144,32768,"unknown","unknown","unknown","unknown","slow","experimental","Text probe timed out."],
  ["nvidia","mistralai/mistral-large-4-1t-a52b","Mistral Large 4 1T",null,null,"unknown","unknown","unknown","unknown","slow","experimental","No response within probe budget."],
  ["nvidia","openai/gpt-oss-20b","GPT OSS 20B",null,null,"unknown","unknown","unknown","unknown","slow","experimental","Text probe timed out."],
  ["openrouter","recursive/flint-v1.0:free","Flint V1.0",262144,235929,"unknown","unknown","unknown","unsupported","unknown","experimental","No available upstream during probe."],
  ["openrouter","xingchen-agi/xing4.0-29b-a4b:free","Xing 4.0 29B A4B",262144,235929,"unknown","unknown","unknown","unsupported","unknown","experimental","Shared upstream rate limit during probe."],
  ["openrouter","nvidia/nemotron-3.5-super-vl:free","Nemotron 3.5 Super VL",1000000,131072,"passed","passed","passed","passed","fast","ready"],
  ["openrouter","dots-studio/dots-3-note-preview:free","Dots 3 Note Preview",512000,460800,"passed","passed","passed","unknown","standard","ready"],
  ["openrouter","nvidia/nemotron-3.5-lightning:free","Nemotron 3.5 Lightning",1000000,65536,"passed","failed","unsupported","unsupported","standard","experimental","Returned unknown/duplicate function calls; strict schema route unavailable."],
  ["openrouter","cohere/north-mini-code:free","North Mini Code",256000,64000,"passed","passed","unsupported","unsupported","standard","ready","JSON Schema route unavailable."],
  ["openrouter","nvidia/nemotron-3-ultra-550b-a55b:free","Nemotron 3 Ultra 550B",1000000,65536,"passed","passed","unsupported","unsupported","fast","ready","JSON Schema route unavailable."],
  ["openrouter","nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free","Nemotron 3 Nano Omni",256000,65536,"passed","passed","unsupported","unknown","standard","ready","JSON Schema route unavailable."],
  ["openrouter","google/gemma-4-26b-a4b-it:free","Gemma 4 26B A4B IT",262144,32768,"unknown","unknown","unsupported","unknown","unknown","experimental","Shared Google model capacity was exhausted."],
  ["openrouter","google/gemma-4-31b-it:free","Gemma 4 31B IT",262144,32768,"passed","unknown","unsupported","unknown","standard","experimental","Tool probe was rate limited; JSON Schema route unavailable."],
  ["openrouter","liquid/lfm-2.5-2.6b:free","Liquid LFM 2.5 2.6B",65536,8192,"unknown","unknown","unknown","unknown","unknown","unavailable","Excluded: below the modern coding/general quality threshold."],
  ["openrouter","nvidia/nemotron-3.5-content-safety:free","Nemotron 3.5 Content Safety",128000,8192,"unknown","unknown","unknown","unknown","unknown","unavailable","Excluded: specialized content-safety model."],
  ["matilda","matilda","Matilda (Maincode)",null,null,"passed","unsupported","passed","unsupported","unknown","experimental","OpenAI-compatible path implemented with a non-streaming upstream bridge and request limits; Matilda model discovery and a FreeRouter streamed smoke remain pending."],
];

export const MODEL_CATALOG: ModelProfile[] = rows.map(([provider, upstream, label, context, maxOutput, text, tools, schema, vision, latency, status, reason]) => ({
  id: `${provider}/${upstream}`, provider, upstream, label, context, maxOutput, text, tools, schema, vision, latency, status, ...(reason ? { reason } : {}),
}));

export const ALIASES: Record<string, string[]> = {
  "fr-fast": ["nvidia/poolside/laguna-xs-2.1", "google/gemini-3.5-flash-lite"],
  "fr-code": ["nvidia/poolside/laguna-xs-2.1", "openrouter/cohere/north-mini-code:free", "google/gemini-3.5-flash"],
  "fr-quality": ["nvidia/deepseek-ai/deepseek-v4.1-flash", "nvidia/stepfun-ai/step-5-preview", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "google/gemini-3.6-flash"],
  "fr-vision": ["nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", "openrouter/nvidia/nemotron-3.5-super-vl:free", "google/gemini-3.5-flash-lite"],
};

export const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
export function publicModels() {
  const now = Math.floor(Date.now() / 1000);
  const exact = MODEL_CATALOG.filter((m) => m.status === "ready" && m.text === "passed").map((m) => ({ id: m.id, object: "model", created: now, owned_by: m.provider }));
  const aliases = Object.keys(ALIASES).concat("fr-auto").map((id) => ({ id, object: "model", created: now, owned_by: "freerouter" }));
  return [...aliases, ...exact];
}
