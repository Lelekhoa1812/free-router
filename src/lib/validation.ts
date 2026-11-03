import { z } from "zod";
import type { CanonicalChat } from "@/lib/providers/openai";

export type ValidationKind = "invalid" | "unsupported_parameter";

export class RequestValidationError extends Error {
  readonly param: string;
  readonly kind: ValidationKind;
  constructor(param: string, message: string, kind: ValidationKind = "invalid") {
    super(message);
    this.name = "RequestValidationError";
    this.param = param;
    this.kind = kind;
  }
}

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) out += typeof segment === "number" ? `[${segment}]` : out ? `.${String(segment)}` : String(segment);
  return out;
}

function toValidationError(error: z.ZodError): RequestValidationError {
  const issue = error.issues[0];
  if (!issue) return new RequestValidationError("request", "Invalid request body");
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "request";
    return new RequestValidationError(key, `Unsupported request field: ${key}`, "unsupported_parameter");
  }
  const path = pathOf(issue.path);
  const kind: ValidationKind = issue.path[0] === "include" || issue.path[0] === "truncation" ? "unsupported_parameter" : "invalid";
  if (!path) return new RequestValidationError("request", issue.message, kind);
  return new RequestValidationError(path, `${path}: ${issue.message}`, kind);
}

const imageUrl = z.union([
  z.string().min(1),
  z.looseObject({ url: z.string().min(1), detail: z.enum(["auto", "low", "high"]).optional() }),
]);

const supportedPartTypes = new Set(["text", "image_url"]);

const contentPart = z.looseObject({
  type: z.string().min(1).max(32),
  text: z.string().optional(),
  image_url: imageUrl.optional(),
}).superRefine((part, ctx) => {
  if (!supportedPartTypes.has(part.type)) {
    ctx.addIssue({ code: "custom", path: ["type"], message: `Unsupported content part type: ${part.type}. Supported: text, image_url` });
    return;
  }
  if (part.type === "text" && typeof part.text !== "string") {
    ctx.addIssue({ code: "custom", path: ["text"], message: "text content parts require a string text field" });
  }
  if (part.type === "image_url" && part.image_url === undefined) {
    ctx.addIssue({ code: "custom", path: ["image_url"], message: "image_url content parts require an image_url field" });
  }
});

const toolCallSchema = z.looseObject({
  id: z.string().min(1).max(200),
  type: z.literal("function").optional(),
  function: z.looseObject({
    name: z.string().min(1).max(64),
    arguments: z.string(),
  }),
});

const messageSchema = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
  name: z.string().min(1).max(64).optional(),
  tool_call_id: z.string().min(1).max(200).optional(),
  tool_calls: z.array(toolCallSchema).max(128).optional(),
  refusal: z.string().nullable().optional(),
}).superRefine((message, ctx) => {
  if (message.role === "tool" && !message.tool_call_id) {
    ctx.addIssue({ code: "custom", path: ["tool_call_id"], message: "tool messages require tool_call_id" });
  }
  if (["system", "developer", "user"].includes(message.role) && message.content == null) {
    ctx.addIssue({ code: "custom", path: ["content"], message: `${message.role} messages require content` });
  }
  if (message.role === "assistant" && message.content == null && !message.tool_calls?.length) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "assistant messages require content or tool_calls" });
  }
});

const toolFunctionSchema = z.looseObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "function name must match [a-zA-Z0-9_-]{1,64}"),
  description: z.string().max(2000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
});

const functionToolSchema = z.looseObject({
  type: z.literal("function"),
  function: toolFunctionSchema,
});

const toolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.looseObject({ type: z.literal("function"), function: z.looseObject({ name: z.string().min(1).max(64) }) }),
]);

const responseFormatSchema = z.looseObject({
  type: z.enum(["text", "json_object", "json_schema"]),
  json_schema: z.looseObject({
    name: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }).optional(),
}).superRefine((format, ctx) => {
  if (format.type === "json_schema" && !format.json_schema) {
    ctx.addIssue({ code: "custom", path: ["json_schema"], message: "response_format.json_schema is required when type is json_schema" });
  }
});

const chatRequestSchema = z.strictObject({
  model: z.string().min(1).max(200),
  messages: z.array(messageSchema).min(1).max(500),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.int().positive().max(2_000_000).optional(),
  max_completion_tokens: z.int().positive().max(2_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().max(4000), z.array(z.string().max(4000)).max(4)]).optional(),
  tools: z.array(functionToolSchema).max(128).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: responseFormatSchema.optional(),
  reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  user: z.string().max(256).optional(),
  prompt_cache_key: z.string().max(256).optional(),
  store: z.boolean().optional(),
}).superRefine((body, ctx) => {
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
    ctx.addIssue({ code: "custom", path: ["max_completion_tokens"], message: "Use only one output-token limit field" });
  }
  if (body.store === true) {
    ctx.addIssue({ code: "custom", path: ["store"], message: "Chat resource storage is unsupported; use Responses API" });
  }
});

/** Validate an OpenAI-shaped Chat Completions request before it reaches a provider. */
export function parseChatRequest(input: unknown): CanonicalChat {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestValidationError("request", "Request must be a JSON object");
  }
  const parsed = chatRequestSchema.safeParse(input);
  if (!parsed.success) throw toValidationError(parsed.error);
  return parsed.data as unknown as CanonicalChat;
}

const responsesContentPart = z.looseObject({
  type: z.string().min(1).max(32),
  text: z.string().optional(),
  image_url: imageUrl.optional(),
});

const responsesInputItem = z.looseObject({
  type: z.string().min(1).max(64).optional(),
  role: z.string().min(1).max(32).optional(),
  content: z.union([z.string(), z.array(responsesContentPart)]).optional(),
}).superRefine((item, ctx) => {
  if (!item.role && !item.type) {
    ctx.addIssue({ code: "custom", path: ["type"], message: "input items require a role or a type" });
  }
});

const responsesSchema = z.strictObject({
  model: z.string().min(1).max(200),
  input: z.union([z.string(), z.array(responsesInputItem).max(500)]).optional(),
  instructions: z.string().max(200_000).optional(),
  previous_response_id: z.string().min(1).max(200).optional(),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  tools: z.array(z.looseObject({ type: z.string().min(1).max(32) })).max(128).optional(),
  tool_choice: z.union([z.enum(["none", "auto", "required"]), z.looseObject({ type: z.literal("function"), name: z.string().min(1).max(64) })]).optional(),
  max_output_tokens: z.int().positive().max(2_000_000).optional(),
  reasoning: z.looseObject({ effort: z.enum(["minimal", "low", "medium", "high"]).optional() }).optional(),
  text: z.looseObject({
    format: z.union([
      z.looseObject({ type: z.enum(["text", "json_object"]) }),
      z.looseObject({ type: z.literal("json_schema"), name: z.string().min(1).max(64), schema: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }),
    ]).optional(),
  }).optional(),
  parallel_tool_calls: z.boolean().optional(),
  metadata: z.record(z.string().max(64), z.string().max(512)).refine((value) => Object.keys(value).length <= 16, "metadata must contain at most 16 entries").optional(),
  truncation: z.literal("disabled").optional(),
  include: z.array(z.string()).length(0, "Requested include fields are not available for this provider profile").optional(),
});

export interface ResponsesRequest {
  model: string;
  input?: unknown;
  instructions?: string;
  previous_response_id?: string;
  stream?: boolean;
  store?: boolean;
  tools?: Array<{ type: string; name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }>;
  tool_choice?: string | { type: "function"; name: string };
  max_output_tokens?: number;
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high" };
  text?: { format?: { type: "text" | "json_object" } | { type: "json_schema"; name: string; schema: Record<string, unknown>; strict?: boolean } };
  parallel_tool_calls?: boolean;
  metadata?: Record<string, string>;
}

/** Validate an OpenAI-shaped Responses request before conversation assembly. */
export function parseResponsesRequest(input: unknown): ResponsesRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestValidationError("request", "Request must be a JSON object");
  }
  const parsed = responsesSchema.safeParse(input);
  if (!parsed.success) throw toValidationError(parsed.error);
  return parsed.data as unknown as ResponsesRequest;
}
