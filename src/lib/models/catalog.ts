export type Provider = "google" | "nvidia" | "openrouter" | "matilda" | "zenmux" | "orcarouter" | "mistral" | "tokenharbor" | "groq" | "novita" | "hyperbolic" | "inference" | "azure";
export type CapabilityState = "passed" | "failed" | "unknown" | "unsupported";
export interface ModelProfile {
  id: string; provider: Provider; upstream: string; label: string; context: number | null; maxOutput: number | null;
  text: CapabilityState; tools: CapabilityState; schema: CapabilityState; vision: CapabilityState; latency: "fast" | "standard" | "slow" | "unknown";
  status: "ready" | "experimental" | "unavailable" | "restricted"; reason?: string;
}

// Cursor documents 200k tokens as its normal context window. Keep fr-code
// candidates at or above that limit; Cursor's custom OpenAI-compatible models
// may otherwise be assigned a larger assumed window than the provider supports.
export const CURSOR_MIN_CONTEXT = 200_000;

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
  ["matilda","matilda","Matilda",null,null,"passed","passed","passed","unsupported","standard","ready","Direct OpenAI SDK probes on 4 November 2026 passed model discovery, streamed chat, JSON mode, strict JSON Schema, system/developer messages, streamed native tools and tool continuation. Inline image_url returned HTTP 400 and remains unsupported. Deployed gateway certification pending."],
  ["mistral","ministral-8b-2512","Ministral 3 8B",262144,null,"passed","passed","passed","passed","fast","ready","Production OpenAI SDK smoke on 5 November 2026 passed streaming, tools and continuation, strict JSON Schema, Responses and a simple vision task. A two-task coding sample missed cases; excluded from fr-code. Cursor acceptance remains pending."],
  ["mistral","ministral-14b-2512","Ministral 3 14B",262144,null,"passed","passed","passed","passed","fast","ready","Production OpenAI SDK smoke on 5 November 2026 passed streaming, tools and continuation, strict JSON Schema, Responses and a simple vision task. A two-task coding sample missed cases; excluded from fr-code. Cursor acceptance remains pending."],
  ["mistral","mistral-small-2603","Mistral Small 4",262144,null,"unknown","unknown","unknown","unknown","unknown","experimental","Listed by Mistral on 5 November 2026 but the attempted direct call returned HTTP 429; live capabilities remain unverified."],
  ["zenmux","deepseek/deepseek-v4-flash","DeepSeek V4 Flash",1048576,32768,"unknown","unknown","unknown","unknown","fast","experimental","Configured provider path; live credential probe and acceptance pending."],
  ["orcarouter","orcarouter/free","OrcaRouter Free Router",262144,32768,"unknown","unknown","unknown","unknown","fast","experimental","Configured provider path; live credential probe and acceptance pending."],
  ["tokenharbor","deepseek-v4-flash:free","DeepSeek V4 Flash (Free)",1048576,32768,"unknown","unknown","unknown","unknown","fast","experimental","Configured provider path; live credential probe and acceptance pending."],
  // Groq Free plan reviewed 11 November 2026. Only the gpt-oss rows are on the published table.
  ["groq","llama-3.3-70b-versatile","Llama 3.3 70B Versatile",131072,32768,"passed","passed","passed","unsupported","fast","ready","Not listed on Groq's published Free plan table reviewed 11 November 2026."],
  ["groq","gpt-oss-120b","GPT-OSS 120B",131072,32768,"passed","passed","passed","unsupported","fast","ready","Groq Free plan, reviewed 11 November 2026: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD."],
  ["groq","gpt-oss-20b","GPT-OSS 20B",131072,32768,"passed","passed","passed","unsupported","fast","ready","Groq Free plan, reviewed 11 November 2026: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD."],
  ["groq","llama-3.1-8b-instant","Llama 3.1 8B Instant",131072,32768,"passed","passed","passed","unsupported","fast","ready","Not listed on Groq's published Free plan table reviewed 11 November 2026."],
  ["groq","whisper-large-v3","Whisper Large v3",null,null,"unsupported","unsupported","unsupported","unsupported","fast","ready","Groq Free plan audio route, reviewed 11 November 2026: 20 RPM, 2,000 RPD, 7,200 audio seconds per hour, 28,800 per day."],
  // Novita AI. Apodex 1.1 Mini is priced at $0. Ling 3.1 Flash is billed per token.
  ["novita","apodex-1.1-mini","Apodex 1.1 Mini",262144,32768,"passed","passed","passed","unsupported","fast","ready","Public Novita model list on 11 November 2026: $0 input and $0 output. T1 rate limits refill, but the official RPM/TPM matrix did not render."],
  ["novita","ling-3.1-flash","Ling 3.1 Flash",1000000,32768,"passed","passed","passed","unsupported","fast","ready","Public Novita model list on 11 November 2026: $0.30 input and $0.90 output per million tokens. This route draws the account balance; it is not a free allowance."],
  // Hyperbolic (Phone verify: 60 RPM, $1 credit)
  ["hyperbolic","deepseek-v4.1-flash","DeepSeek V4.1 Flash",1048576,32768,"passed","passed","passed","unsupported","fast","ready","Hyperbolic Free Tier, reviewed 11 November 2026: phone verification adds $1 and a 60 RPM limit. Per-token billing stops at a zero balance."],
  ["hyperbolic","glm-5.3-flash","GLM 5.3 Flash",1048576,32768,"passed","passed","passed","unsupported","fast","ready","Hyperbolic Free Tier, reviewed 11 November 2026: phone verification adds $1 and a 60 RPM limit. Per-token billing stops at a zero balance."],
  ["hyperbolic","qwen3.8-27b","Qwen 3.8 27B",262144,32768,"passed","passed","passed","unsupported","fast","ready","Hyperbolic Free Tier, reviewed 11 November 2026: phone verification adds $1 and a 60 RPM limit. Per-token billing stops at a zero balance."],
  ["hyperbolic","pixtral-12b","Pixtral 12B",131072,32768,"passed","passed","passed","passed","fast","ready","Hyperbolic Free Tier vision route, reviewed 11 November 2026: phone verification adds $1 and a 60 RPM limit. Per-token billing stops at a zero balance."],
  ["hyperbolic","llama-3.1-405b-fp8","Llama 3.1 405B FP8",131072,32768,"passed","passed","passed","unsupported","slow","experimental","Hyperbolic Free Tier large route, reviewed 11 November 2026: phone verification adds $1 and a 60 RPM limit. Per-token billing stops at a zero balance."],
  // Inference.net Pay as you go: 30 RPM and 1,000,000 included gateway requests.
  ["inference","gpt-6.1-sol","GPT-6.1 Sol",128000,32768,"passed","passed","passed","unsupported","fast","ready","Inference.net Pay as you go, reviewed 11 November 2026: 30 RPM and 1,000,000 included gateway requests. Token use is billed from the account balance."],
  ["inference","claude-opus-5.5","Claude Opus 5.5",200000,65536,"passed","passed","passed","passed","standard","ready","Inference.net Pay as you go, reviewed 11 November 2026: 30 RPM and 1,000,000 included gateway requests. Vision capable. Token use is billed from the account balance."],
  ["inference","gemini-3.7-flash","Gemini 3.7 Flash",1048576,65536,"passed","passed","passed","passed","fast","ready","Inference.net Pay as you go, reviewed 11 November 2026: 30 RPM and 1,000,000 included gateway requests. Vision capable. Token use is billed from the account balance."],
  ["inference","deepseek-v4.1-flash","DeepSeek V4.1 Flash",1048576,32768,"passed","passed","passed","unsupported","fast","ready","Inference.net Pay as you go, reviewed 11 November 2026: 30 RPM and 1,000,000 included gateway requests. Token use is billed from the account balance."],
  ["inference","glm-5.3-flash","GLM 5.3 Flash",1048576,32768,"passed","passed","passed","unsupported","fast","ready","Inference.net Pay as you go, reviewed 11 November 2026: 30 RPM and 1,000,000 included gateway requests. Token use is billed from the account balance."],
  // Azure OpenAI published Tier 0 GlobalStandard windows, reviewed 11 November 2026.
  ["azure","gpt-4.1-mini","GPT-4.1 Mini",128000,16384,"passed","passed","passed","unsupported","fast","ready","Azure OpenAI tier 0 GlobalStandard, reviewed 11 November 2026: 200 RPM and 200,000 TPM. Free tier cannot request an increase."],
  ["azure","gpt-5-mini","GPT-5 Mini",128000,16384,"passed","passed","passed","unsupported","fast","ready","Azure OpenAI tier 0 GlobalStandard, reviewed 11 November 2026: 500 RPM and 500,000 TPM. Free tier cannot request an increase."],
  ["azure","o4-mini","o4 Mini",128000,16384,"passed","passed","passed","unsupported","fast","ready","Azure OpenAI tier 0 GlobalStandard, reviewed 11 November 2026: 100 RPM and 100,000 TPM. Free tier cannot request an increase."],
  ["azure","text-embedding-3-small","Text Embedding 3 Small",8192,null,"unsupported","unsupported","unsupported","unsupported","fast","ready","Azure OpenAI tier 0 GlobalStandard, reviewed 11 November 2026: 1,000 requests per 10 seconds and 1,000,000 TPM."],
];

export const MODEL_CATALOG: ModelProfile[] = rows.map(([provider, upstream, label, context, maxOutput, text, tools, schema, vision, latency, status, reason]) => ({
  id: `${provider}/${upstream}`, provider, upstream, label, context, maxOutput, text, tools, schema, vision, latency, status, ...(reason ? { reason } : {}),
}));

export const ALIASES: Record<string, string[]> = {
  // Keep every ready text model reachable from at least one category. fr-auto
  // resolves to one of these tiers after its deterministic/optional Jev choice.
  "fr-fast": [
    "nvidia/poolside/laguna-xs-2.1",
    "google/gemini-3.1-flash-lite-preview",
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.5-flash-lite",
    "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    "openrouter/nvidia/nemotron-3.5-super-vl:free",
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "mistral/ministral-8b-2512",
    "mistral/ministral-14b-2512",
    "groq/llama-3.1-8b-instant",
    "groq/gpt-oss-20b",
    "novita/apodex-1.1-mini",
    "novita/ling-3.1-flash",
    "hyperbolic/qwen3.8-27b",
    "inference/gemini-3.7-flash",
    "inference/gpt-6.1-sol",
    "azure/gpt-4.1-mini",
    "azure/gpt-5-mini",
    "azure/o4-mini",
  ],
  "fr-code": [
    "nvidia/poolside/laguna-xs-2.1",
    "openrouter/cohere/north-mini-code:free",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.5-flash-lite",
    "openrouter/dots-studio/dots-3-note-preview:free",
    "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "novita/apodex-1.1-mini",
    "hyperbolic/deepseek-v4.1-flash",
    "hyperbolic/glm-5.3-flash",
    "inference/deepseek-v4.1-flash",
    "inference/glm-5.3-flash",
  ],
  "fr-quality": [
    "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemini-3.6-flash",
    "openrouter/dots-studio/dots-3-note-preview:free",
    "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
    "openrouter/nvidia/nemotron-3.5-super-vl:free",
    "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "matilda/matilda",
    "groq/gpt-oss-120b",
    "groq/llama-3.3-70b-versatile",
    "hyperbolic/llama-3.1-405b-fp8",
    "inference/claude-opus-5.5",
    "azure/gpt-4.1-mini",
  ],
  // Vision is restricted to bindings whose image request was explicitly verified.
  "fr-vision": [
    "openrouter/nvidia/nemotron-3.5-super-vl:free",
    "google/gemini-3.5-flash-lite",
    "mistral/ministral-8b-2512",
    "mistral/ministral-14b-2512",
    "hyperbolic/pixtral-12b",
    "inference/claude-opus-5.5",
    "inference/gemini-3.7-flash",
  ],
};

export const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
export function publicModels() {
  const now = Math.floor(Date.now() / 1000);
  const exact = MODEL_CATALOG.filter((m) => m.status === "ready" && m.text === "passed").map((m) => ({ id: m.id, object: "model", created: now, owned_by: m.provider }));
  const aliases = Object.keys(ALIASES).concat("fr-auto").map((id) => ({ id, object: "model", created: now, owned_by: "freerouter" }));
  return [...aliases, ...exact];
}
