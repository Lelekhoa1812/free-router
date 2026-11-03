import type { ModelProfile } from "@/lib/models/catalog";

const MAX_TOKENS = 2_000_000;
const CHARS_PER_TOKEN = 3.2;
const DEFAULT_OUTPUT_RESERVE = 4_096;
const MAX_OUTPUT_RESERVE = 8_192;

export interface NormalizedUsage {
  input: number;
  output: number;
  total: number;
}

export interface ResolvedUsage extends NormalizedUsage {
  source: "provider" | "estimated";
}

function finiteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function clamp(value: number): number {
  return Math.min(MAX_TOKENS, Math.max(0, Math.round(value)));
}

function textTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

function contentTokens(content: unknown): number {
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return content == null ? 0 : textTokens(JSON.stringify(content));
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      total += textTokens(String(part ?? ""));
      continue;
    }
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") total += textTokens(value.text);
    else if (value.type === "image_url") {
      const image = value.image_url;
      const detail = image && typeof image === "object" ? (image as Record<string, unknown>).detail : undefined;
      total += detail === "low" ? 256 : 1_024;
    } else total += textTokens(JSON.stringify(value));
  }
  return total;
}

/** Conservative request-side estimate; provider-reported usage wins when present. */
export function estimatePromptTokens(messages: unknown[], tools?: unknown): number {
  let total = 0;
  for (const raw of messages) {
    total += 4;
    if (!raw || typeof raw !== "object") {
      total += textTokens(String(raw ?? ""));
      continue;
    }
    const message = raw as Record<string, unknown>;
    total += contentTokens(message.content);
    if (message.tool_calls) total += textTokens(JSON.stringify(message.tool_calls));
    if (typeof message.name === "string") total += textTokens(message.name);
  }
  if (tools) total += textTokens(JSON.stringify(tools));
  return clamp(Math.max(1, total));
}

/** Reserve at most 8K output tokens even when the caller asks for more. */
export function estimateOutputReserve(input: Record<string, unknown>, profile: ModelProfile): number {
  const requested = finiteInt(input.max_completion_tokens ?? input.max_tokens);
  const modelCap = profile.maxOutput && profile.maxOutput > 0 ? Math.min(profile.maxOutput, MAX_OUTPUT_RESERVE) : DEFAULT_OUTPUT_RESERVE;
  if (requested !== undefined && requested > 0) return clamp(Math.min(requested, modelCap));
  return clamp(Math.min(DEFAULT_OUTPUT_RESERVE, modelCap));
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const input = finiteInt(value.prompt_tokens ?? value.input_tokens);
  const output = finiteInt(value.completion_tokens ?? value.output_tokens);
  if (input === undefined && output === undefined) return null;
  const safeInput = input ?? 0;
  const safeOutput = output ?? 0;
  const total = finiteInt(value.total_tokens) ?? safeInput + safeOutput;
  return { input: clamp(safeInput), output: clamp(safeOutput), total: clamp(Math.max(total, safeInput + safeOutput)) };
}

export function estimatedUsage(promptTokens: number, content = "", toolCalls?: unknown): NormalizedUsage {
  const output = clamp(textTokens(content) + (toolCalls ? textTokens(JSON.stringify(toolCalls)) : 0));
  return { input: clamp(promptTokens), output, total: clamp(promptTokens + output) };
}

export function resolveUsage(
  raw: unknown,
  promptTokens: number,
  content = "",
  toolCalls?: unknown,
): ResolvedUsage {
  const provider = normalizeUsage(raw);
  if (provider) return { ...provider, source: "provider" };
  return { ...estimatedUsage(promptTokens, content, toolCalls), source: "estimated" };
}
