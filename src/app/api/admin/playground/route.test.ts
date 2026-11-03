import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(), getProviderCredentials: vi.fn(), upstreamChat: vi.fn(),
  checkAdmission: vi.fn(), releaseAdmission: vi.fn(), getDb: vi.fn(), reserveQuota: vi.fn(), settleQuota: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession }));
vi.mock("@/lib/providers/credentials", () => ({ getProviderCredentials: mocks.getProviderCredentials }));
vi.mock("@/lib/providers/openai", async () => { const actual = await vi.importActual<any>("@/lib/providers/openai"); return { ...actual, upstreamChat: mocks.upstreamChat }; });
vi.mock("@/lib/redis", () => ({ checkAdmission: mocks.checkAdmission, releaseAdmission: mocks.releaseAdmission }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/quota/ledger", async () => { const actual = await vi.importActual<any>("@/lib/quota/ledger"); return { ...actual, reserveQuota: mocks.reserveQuota, settleQuota: mocks.settleQuota }; });

import { POST } from "./route";

async function readEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: any }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || "";
    for (const frame of frames) {
      const eventName = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const payload = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (payload) events.push({ event: eventName, data: JSON.parse(payload) });
    }
  }
  return events;
}

describe("admin playground streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue({ actor: "admin" });
    mocks.getProviderCredentials.mockReturnValue([{ provider: "google", slot: 1, secret: "test-secret", fingerprint: "test-fingerprint" }]);
    mocks.checkAdmission.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mocks.releaseAdmission.mockResolvedValue(undefined);
    mocks.reserveQuota.mockResolvedValue({ allowed: true });
    mocks.settleQuota.mockResolvedValue(true);
    const collection = { insertOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
    mocks.getDb.mockResolvedValue({ collection: vi.fn(() => collection) });
  });

  afterEach(() => vi.restoreAllMocks());

  it("streams text deltas and reports route and latency metrics", async () => {
    const reservation = { id: "playground", target: { provider: "google", group: "default", model: "google/gemini-3.6-flash", scope: "model", limits: { rpm: 5 }, timeZone: "UTC" }, estimate: 10, mode: "enforce", keys: ["a", "b", "c", "d"], resetAt: new Date(), minuteResetSeconds: 60, dayResetSeconds: 60, dayTtl: 3600 };
    mocks.reserveQuota.mockResolvedValue({ allowed: true, reservation });
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const response = await POST(new Request("https://freerouter.test/api/admin/playground", {
      method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash", messages: [{ role: "user", content: "Say hello" }], stream: true }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(response);
    expect(events.map((entry) => entry.event)).toContain("status");
    expect(events.filter((entry) => entry.event === "delta").map((entry) => entry.data.content).join("")).toBe("Hello world");
    const complete = events.find((entry) => entry.event === "complete")?.data;
    expect(complete.resolvedModel).toBe("google/gemini-3.6-flash");
    expect(complete.requestId).toMatch(/^fr_/);
    expect(complete.durationMs).toBeGreaterThanOrEqual(0);
    expect(complete.ttftMs).toBeGreaterThanOrEqual(0);
    expect(mocks.upstreamChat).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ stream: true }), expect.any(AbortSignal));
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
    expect(mocks.settleQuota).toHaveBeenCalledWith(reservation, expect.objectContaining({ outcome: "completed" }));
  });

  it("reports quota exhaustion without dispatching upstream", async () => {
    mocks.reserveQuota.mockResolvedValue({ allowed: false, reason: "request_day", retryAfterMs: 120_000 });
    const response = await POST(new Request("https://freerouter.test/api/admin/playground", {
      method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash", messages: [{ role: "user", content: "Hi" }] }),
    }));
    const events = await readEvents(response);
    const failure = events.find((entry) => entry.event === "failure")?.data;
    expect(failure.message).toContain("Quota is exhausted");
    expect(mocks.upstreamChat).not.toHaveBeenCalled();
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
  });

  it("reports a sanitized failure event when no candidate can be admitted", async () => {
    mocks.checkAdmission.mockResolvedValue({ allowed: false, retryAfter: 12 });
    const response = await POST(new Request("https://freerouter.test/api/admin/playground", {
      method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash", messages: [{ role: "user", content: "Hi" }] }),
    }));
    const events = await readEvents(response);
    const failure = events.find((entry) => entry.event === "failure")?.data;
    expect(failure.message).toContain("retry after 12s");
    expect(events.some((entry) => entry.event === "complete")).toBe(false);
    expect(mocks.upstreamChat).not.toHaveBeenCalled();
  });

  it("settles a tool-only response with an estimated output reservation", async () => {
    const reservation = { id: "playground-tool", target: { provider: "google", group: "default", model: "google/gemini-3.6-flash", scope: "model", limits: { rpm: 5 }, timeZone: "UTC" }, estimate: 10, mode: "enforce", keys: ["a", "b", "c", "d"], resetAt: new Date(), minuteResetSeconds: 60, dayResetSeconds: 60, dayTtl: 3600 };
    mocks.reserveQuota.mockResolvedValue({ allowed: true, reservation });
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"a long tool argument payload\"}" } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const response = await POST(new Request("https://freerouter.test/api/admin/playground", {
      method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash", messages: [{ role: "user", content: "Use the lookup tool" }] }),
    }));

    const events = await readEvents(response);
    expect(events.find((entry) => entry.event === "complete")?.data.toolCalls).toHaveLength(1);
    expect(mocks.settleQuota).toHaveBeenCalledWith(reservation, expect.objectContaining({ outcome: "completed" }));
    const usage = mocks.settleQuota.mock.calls[0][1].usage;
    expect(usage.source).toBe("estimated");
    expect(usage.output).toBeGreaterThan(0);
  });

  it("does not label a truncated upstream stream as complete", async () => {
    mocks.upstreamChat.mockResolvedValue(new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const response = await POST(new Request("https://freerouter.test/api/admin/playground", {
      method: "POST", headers: { origin: "https://freerouter.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.6-flash", messages: [{ role: "user", content: "Hi" }] }),
    }));
    const events = await readEvents(response);
    expect(events.find((entry) => entry.event === "delta")?.data.content).toBe("partial");
    expect(events.find((entry) => entry.event === "failure")?.data.message).toContain("before a finish reason");
    expect(events.some((entry) => entry.event === "complete")).toBe(false);
    expect(mocks.releaseAdmission).toHaveBeenCalledOnce();
  });
});
