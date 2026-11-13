import { createHash } from "node:crypto";
import { MAX_JSON_BODY_BYTES } from "./http";
import { RequestValidationError, type ResponsesRequest, type ResponsesTool } from "./validation";

type Identity = { name: string; namespace?: string };

// Chat tool names are limited to 64 characters. Hash the full public identity
// deterministically so replay and stored continuation use the same wire name.
function wireName({ name, namespace }: Identity) {
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith("frt_")) return name;
  return `frt_${createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 56)}`;
}

function identity(name: unknown, namespace?: unknown): Identity {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) {
    throw new RequestValidationError("tools", "Function names must be 1–128 letters, digits, underscores, dots or hyphens");
  }
  if (namespace !== undefined && (typeof namespace !== "string" || !/^[a-zA-Z0-9_.-]{1,256}$/.test(namespace))) {
    throw new RequestValidationError("tools", "Invalid function namespace");
  }
  return { name, ...(typeof namespace === "string" ? { namespace } : {}) };
}

/** Bridge caller-executed namespaced functions to providers' flat Chat tools. */
export function responsesTools(declarations: ResponsesTool[] = []) {
  const identities = new Map<string, Identity>();
  // Namespace descriptions repeat in flat Chat tools. Bound the expanded bytes
  // incrementally so a small namespaced request cannot amplify without limit.
  let expandedBytes = 2; // JSON array brackets
  const tools: Array<{ type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } }> = [];
  const add = (tool: ResponsesTool, namespace?: string, namespaceDescription?: string) => {
    if (tool?.type !== "function") {
      throw new RequestValidationError("tools", "Only caller-executed function tools and function namespaces are supported", "unsupported_parameter");
    }
    const publicName = identity(tool.name, namespace);
    const name = wireName(publicName);
    if (identities.has(name)) throw new RequestValidationError("tools", "Duplicate function identity");
    identities.set(name, publicName);
    const description = namespace
      ? `[${namespace}.${publicName.name}] ${namespaceDescription || ""}\n${tool.description || ""}`
      : tool.description;
    const translated = { type: "function" as const, function: { name, description, parameters: tool.parameters, strict: tool.strict } };
    expandedBytes += Buffer.byteLength(JSON.stringify(translated), "utf8") + (tools.length ? 1 : 0);
    if (expandedBytes > MAX_JSON_BODY_BYTES) throw new RequestValidationError("tools", "Expanded tool definitions exceed the 4 MiB JSON size limit");
    tools.push(translated);
  };
  for (const tool of declarations) {
    if (tool.type === "namespace") {
      const namespace = identity(tool.name).name;
      if (!Array.isArray(tool.tools) || !tool.tools.length) throw new RequestValidationError("tools", "Namespaces require at least one function");
      for (const member of tool.tools) add(member, namespace, tool.description);
    } else add(tool);
  }
  return {
    tools: declarations.length ? tools : undefined,
    encode(name: unknown, namespace?: unknown) { return wireName(identity(name, namespace)); },
    decode(name: string): Identity | undefined {
      return identities.get(name) ?? (tools.length === 0 ? { name } : undefined);
    },
    choice(choice: ResponsesRequest["tool_choice"]) {
      if (!choice || typeof choice === "string") return choice;
      const name = wireName(identity(choice.name, choice.namespace));
      if (!identities.has(name)) throw new RequestValidationError("tool_choice", "Selected function is not declared in tools");
      return { type: "function", function: { name } };
    },
  };
}

export type ResponsesTools = ReturnType<typeof responsesTools>;
