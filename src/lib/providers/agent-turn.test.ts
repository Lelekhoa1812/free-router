import { describe, expect, it, vi } from "vitest";
import { agentTurnChat, agentTurnTools } from "./agent-turn";
import type { CanonicalChat } from "./openai";

const call = (name: string, args: object, id = "call-1") => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function chat(calls: ReturnType<typeof call>[], finish = "tool_calls", usage: any = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }) {
  const frames: any[] = [{ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
  if (usage) frames.push({ choices: [], usage });
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const body: CanonicalChat = { model: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", messages: [{ role: "user", content: "Finish the checks" }], max_completion_tokens: 100, tools: [] };
const options = (dispatch: any) => ({ body: structuredClone(body), progress: "private_progress", finish: "private_finish", signal: new AbortController().signal, dispatch });

describe("Explicit agent-turn runtime", () => {
  it("keeps control identities stable and avoids caller namespace collisions", () => {
    const declarations = [{ type: "namespace", name: "freerouter_runtime", tools: [] }];
    expect(agentTurnTools([]).name).toBe("freerouter_runtime");
    expect(agentTurnTools(declarations).name).toBe("freerouter_runtime_1");
    expect(agentTurnTools(declarations)).toEqual(agentTurnTools(declarations));
  });
  it("continues progress in the same response, preserves budgets/usage and returns the caller action exactly once", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(chat([call("private_progress", { message: "Let me fix the script." })])).mockResolvedValueOnce(chat([call("caller_tool", { step: 2 }, "external-call")]));
    const before = structuredClone(body);
    const response = await agentTurnChat(options(dispatch));
    const wire = await response.text();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][0]).toMatchObject({ tool_choice: "required", max_completion_tokens: 90 });
    expect(dispatch.mock.calls[1][0].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(wire).toContain("Let me fix the script.");
    expect(wire).toContain('"id":"external-call"');
    expect(wire).not.toContain("private_progress");
    expect(wire).toContain('"prompt_tokens":200,"completion_tokens":20,"total_tokens":220');
    expect(wire).toContain("data: [DONE]");
    expect(body).toEqual(before);
  });

  it.each(["complete", "blocked", "needs_input", "stopped"])("ends deliberately for %s without asking for another action", async status => {
    const dispatch = vi.fn().mockResolvedValue(chat([call("private_finish", { status, message: "Final response" })]));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(wire).toContain('"content":"Final response"');
    expect(wire).toContain('"finish_reason":"stop"');
    expect(wire).not.toContain("private_finish");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails bounded progress loops and unmarked text stops instead of falsely completing", async () => {
    const dispatch = vi.fn().mockImplementation(() => Promise.resolve(chat([call("private_progress", { message: "Still working" })])));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(wire).toContain("Agent progress continuation limit reached");
    expect(wire).not.toContain("[DONE]");
    const noAction = vi.fn().mockResolvedValue(chat([], "stop"));
    const noActionWire = await (await agentTurnChat(options(noAction))).text();
    expect(noActionWire).toContain("ended without an agent action or finish control");
    expect(noAction).toHaveBeenCalledOnce();
  });

  it("preserves token-limit termination without dispatching a continuation", async () => {
    const dispatch = vi.fn().mockResolvedValue(chat([call("private_progress", { message: "Progress" })], "length"));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(wire).toContain('"finish_reason":"length"');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("handles truncated control JSON as an incomplete response", async () => {
    const truncated = call("private_progress", {});
    truncated.function.arguments = '{"message":"unfinished';
    const dispatch = vi.fn().mockResolvedValue(chat([truncated], "length"));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(wire).toContain('"finish_reason":"length"');
    expect(wire).not.toContain("agent_turn_failed");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not continue a budgeted turn when upstream usage is unavailable", async () => {
    const dispatch = vi.fn().mockResolvedValue(chat([call("private_progress", { message: "Progress" })], "tool_calls", null));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(wire).toContain("Cannot preserve the output budget without upstream usage");
    expect(wire).not.toContain("[DONE]");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not retry failed continuations or combine finish with a caller action", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(chat([call("private_progress", { message: "Progress" })])).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const wire = await (await agentTurnChat(options(dispatch))).text();
    expect(wire).toContain("HTTP 503");
    expect(wire).not.toContain("[DONE]");
    expect(dispatch).toHaveBeenCalledTimes(2);
    const mixed = vi.fn().mockResolvedValue(chat([call("private_finish", { status: "complete", message: "Done" }), { ...call("caller_tool", {}), index: 1 }]));
    expect(await (await agentTurnChat(options(mixed))).text()).toContain("Conflicting agent finish and tool actions");
  });

  it("cancels the upstream on client cancellation", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const dispatch = vi.fn(async (_body, signal: AbortSignal) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); } }));
    });
    const response = await agentTurnChat(options(dispatch));
    await response.body!.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
