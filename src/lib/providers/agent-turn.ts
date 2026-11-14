import type { CanonicalChat } from "./openai";
import type { ResponsesTool } from "../validation";

export const AGENT_TURN_INSTRUCTIONS = `Tool-enabled agent protocol: use the caller's declared tools to perform authorized actions. A text-only response ends the client turn. To give a progress update while more work remains, call the private runtime progress function; the adapter will continue the same turn. When the task is complete, blocked, needs user input/permission, or the user asks you to stop, call the private runtime finish function with your answer and the appropriate status. Do not finish with only a promise of another action. Correct tool errors and continue useful authorized work. Respect current runtime limits and user stops; historical budget notices are not new stop instructions. Runtime functions only communicate with the client; they do not execute business tools.`;

export function agentTurnTools(declarations: ResponsesTool[]): ResponsesTool {
  // Keep the tool prefix stable for provider prompt caching, without reserving
  // or colliding with a namespace the caller already owns.
  const existing = new Set(declarations.filter(tool => tool.type === "namespace").map(tool => tool.name));
  let namespace = "freerouter_runtime", suffix = 0;
  while (existing.has(namespace)) namespace = `freerouter_runtime_${++suffix}`;
  return { type: "namespace", name: namespace, description: "Private agent-turn runtime controls; use caller tools for actual work.", tools: [
    { type: "function", name: "progress", description: "Report progress while work remains, then continue the current agent turn.", strict: true, parameters: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["message"], additionalProperties: false } },
    { type: "function", name: "finish", description: "End the agent turn with the final answer, an actual blocker, a necessary user question, or acknowledgement of a user stop. Do not use for progress or promises.", strict: true, parameters: { type: "object", properties: { status: { type: "string", enum: ["complete", "blocked", "needs_input", "stopped"] }, message: { type: "string", minLength: 1 } }, required: ["status", "message"], additionalProperties: false } },
  ] };
}

async function completion(response: Response) {
  if (!response.ok) throw new Error(`Agent continuation failed (HTTP ${response.status})`);
  if (!response.body) throw new Error("The upstream stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, any>();
  let buffer = "", content = "", finish: string | null = null, done = false, usage: any;
  const frame = (wire: string) => {
    const data = wire.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message || "Agent upstream failed");
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    for (const call of choice?.delta?.tool_calls || []) {
      const previous = calls.get(call.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) previous.id = call.id;
      previous.function.name += call.function?.name || "";
      previous.function.arguments += call.function?.arguments || "";
      calls.set(call.index, previous);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (event.usage) usage = event.usage;
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || "";
      frames.forEach(frame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) frame(buffer);
    if (!done || !finish) throw new Error("Agent upstream ended without a successful finish event");
    return { message: { role: "assistant", content: content || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }, finish, usage };
  } finally { await reader.cancel().catch(() => undefined); }
}

/** Continue explicit progress controls only; never re-dispatch a caller tool. */
export async function agentTurnChat(options: {
  body: CanonicalChat; progress: string; finish: string; signal: AbortSignal;
  dispatch: (body: CanonicalChat, signal: AbortSignal) => Promise<Response>;
}) {
  const aborter = new AbortController();
  const signal = AbortSignal.any([options.signal, aborter.signal]);
  const timer = setTimeout(() => aborter.abort(new Error("Agent turn deadline exceeded")), 275_000);
  const body = { ...options.body, stream: true, stream_options: { include_usage: true }, tool_choice: "required" };
  let first: Response;
  try { first = await options.dispatch(body, signal); }
  catch (error) { clearTimeout(timer); throw error; }
  if (!first.ok) { clearTimeout(timer); return first; }
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { void (async () => {
      const send = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
      const delta = (value: Record<string, unknown>) => send({ choices: [{ index: 0, delta: value, finish_reason: null }] });
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let sawUsage = false, missingUsage = false;
      let response = first;
      let progressCount = 0;
      try {
        for (;;) {
          const next = await completion(response);
          if (next.usage && [next.usage.prompt_tokens, next.usage.completion_tokens, next.usage.total_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
            sawUsage = true;
            usage.prompt_tokens += next.usage.prompt_tokens;
            usage.completion_tokens += next.usage.completion_tokens;
            usage.total_tokens += next.usage.total_tokens;
          } else missingUsage = true;
          const calls = next.message.tool_calls || [];
          const progress = calls.filter(call => call.function.name === options.progress);
          const finish = calls.filter(call => call.function.name === options.finish);
          const external = calls.filter(call => call.function.name !== options.progress && call.function.name !== options.finish);
          if (next.message.content) delta({ content: next.message.content });
          if (next.finish === "length") {
            send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
            break;
          }
          for (const call of progress) {
            const args = JSON.parse(call.function.arguments);
            if (typeof args.message !== "string" || !args.message.trim()) throw new Error("Invalid agent progress control");
            delta({ content: `${args.message}\n\n` });
          }
          if (finish.length && (external.length || finish.length > 1)) throw new Error("Conflicting agent finish and tool actions");
          if (external.length) {
            delta({ tool_calls: external.map((call, index) => ({ ...call, index })) });
            send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            break;
          }
          if (finish.length) {
            const args = JSON.parse(finish[0].function.arguments);
            if (!["complete", "blocked", "needs_input", "stopped"].includes(args.status) || typeof args.message !== "string" || !args.message.trim()) throw new Error("Invalid agent finish control");
            delta({ content: args.message });
            send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            break;
          }
          const outputLimit = options.body.max_completion_tokens ?? options.body.max_tokens;
          if (outputLimit !== undefined && usage.completion_tokens >= outputLimit) {
            send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
            break;
          }
          if (!progress.length) throw new Error("The model ended without an agent action or finish control");
          if (++progressCount > 2) throw new Error("Agent progress continuation limit reached");
          if (outputLimit !== undefined && missingUsage) throw new Error("Cannot preserve the output budget without upstream usage");
          const messages = [...body.messages, next.message, ...progress.map(call => ({ role: "tool", tool_call_id: call.id, content: "Progress delivered. Continue with the next authorized caller tool or finish when the task is complete or blocked." }))];
          body.messages = messages;
          if (outputLimit !== undefined) {
            delete body.max_tokens;
            body.max_completion_tokens = outputLimit - usage.completion_tokens;
          }
          response = await options.dispatch(body, signal);
        }
        if (sawUsage && !missingUsage) send({ choices: [], usage });
        if (!cancelled) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
      } catch (error) {
        if (!signal.aborted) send({ error: { code: "agent_turn_failed", message: error instanceof Error ? error.message : "Agent turn failed" } });
        if (!cancelled) controller.close();
      } finally { clearTimeout(timer); aborter.abort(); }
    })(); },
    cancel() { cancelled = true; aborter.abort(); clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "x-freerouter-resolved-model": first.headers.get("x-freerouter-resolved-model") || options.body.model } });
}
