import { describe, expect, it, vi } from "vitest";
import { applyVerdict, classifyUpstream, retryAfterMs, summarizeFailures, type UpstreamVerdict } from "./failures";

describe("classifyUpstream", () => {
  it("marks the credential invalid on 401 and rotates it", () => {
    const verdict = classifyUpstream({ status: 401 });
    expect(verdict).toMatchObject({ action: "continue", credential: "invalid", status: 401 });
    expect(verdict.binding).toBeUndefined();
  });

  it("treats 403 as a credential fault instead of silently continuing", () => {
    expect(classifyUpstream({ status: 403 })).toMatchObject({ action: "continue", credential: "invalid", reason: "403" });
  });

  it("exhausts the credential on 402 without touching the binding", () => {
    const verdict = classifyUpstream({ status: 402, retryAfter: "120" });
    expect(verdict).toMatchObject({ credential: "exhausted", action: "continue" });
    expect(verdict.retryAfterMs).toBe(120_000);
    expect(verdict.binding).toBeUndefined();
  });

  it("stops on a caller fault without disabling the binding", () => {
    const verdict = classifyUpstream({ status: 400, providerCode: "invalid_request_error" });
    expect(verdict).toMatchObject({ action: "stop_model", status: 400 });
    expect(verdict.binding).toBeUndefined();
    expect(verdict.credential).toBeUndefined();
    expect(verdict.reason).toBe("400:invalid_request_error");
  });

  it("removes a model that the provider reports as gone", () => {
    expect(classifyUpstream({ status: 404 })).toMatchObject({ action: "stop_model", binding: "unavailable" });
    expect(classifyUpstream({ status: 410 })).toMatchObject({ action: "stop_model", binding: "unavailable" });
  });

  it("cools the binding on 429 and honours retry-after", () => {
    const verdict = classifyUpstream({ status: 429, retryAfter: "45" });
    expect(verdict).toMatchObject({ action: "continue", binding: "cooldown", retryAfterMs: 45_000 });
  });

  it("stops the model and trips the overload breaker on 503", () => {
    expect(classifyUpstream({ status: 503 })).toMatchObject({ action: "stop_model", overload: true, binding: "cooldown" });
  });

  it("keeps trying other credentials on a plain 5xx", () => {
    expect(classifyUpstream({ status: 500 })).toMatchObject({ action: "continue", binding: "cooldown" });
  });

  it("retries transient timeouts", () => {
    expect(classifyUpstream({ status: 408 })).toMatchObject({ action: "continue", status: 408 });
    expect(classifyUpstream({ status: 425 }).credential).toBeUndefined();
  });

  it("classifies transport failures with no status", () => {
    expect(classifyUpstream({ status: null })).toMatchObject({ status: null, action: "continue", reason: "transport_error" });
    expect(classifyUpstream({})).toMatchObject({ status: null, reason: "transport_error" });
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");

  it("defaults to 30 seconds when the header is absent or invalid", () => {
    expect(retryAfterMs(null, now)).toBe(30_000);
    expect(retryAfterMs("not-a-delay", now)).toBe(30_000);
  });

  it("parses delta seconds and HTTP dates", () => {
    expect(retryAfterMs("12", now)).toBe(12_000);
    expect(retryAfterMs("Tue, 03 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("clamps past dates to zero and caps future delays", () => {
    expect(retryAfterMs("Tue, 03 Nov 2026 11:59:00 GMT", now)).toBe(0);
    expect(retryAfterMs("999999", now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("summarizeFailures", () => {
  const failure = (status: number | null, reason = String(status)): UpstreamVerdict => ({ status, action: "continue", reason });

  it("reports quota exhaustion when every failure is 429", () => {
    expect(summarizeFailures([failure(429), failure(429)], 2)).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  });

  it("reports a bad request when every failure is 400", () => {
    expect(summarizeFailures([failure(400), failure(400)], 2)).toMatchObject({ status: 400, code: "upstream_request_rejected" });
  });

  it("reports invalid output above transport failures", () => {
    expect(summarizeFailures([failure(400), failure(200, "json_schema_validation_failed")], 2)).toMatchObject({ status: 502, code: "upstream_invalid_output" });
  });

  it("reports upstream unavailability for mixed failures", () => {
    expect(summarizeFailures([failure(401), failure(503)], 2)).toMatchObject({ status: 503, code: "upstream_unavailable" });
  });

  it("reports quota exhaustion when nothing could be dispatched", () => {
    expect(summarizeFailures([], 0)).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  });
});

describe("applyVerdict", () => {
  function fakeDb() {
    const updateOne = vi.fn().mockResolvedValue({});
    return { db: { collection: vi.fn(() => ({ updateOne })) } as never, updateOne };
  }

  it("writes credential health and binding cooldown for a 429", async () => {
    const { db, updateOne } = fakeDb();
    await applyVerdict(db, classifyUpstream({ status: 429, retryAfter: "60" }), { provider: "google", model: "gemini-test", fingerprint: "fp" });
    expect(updateOne).toHaveBeenCalledWith(
      { provider: "google", model: "gemini-test", fingerprint: "fp" },
      { $set: { cooldownUntil: expect.any(Date), reason: "429", checkedAt: expect.any(Date) } },
      { upsert: true },
    );
  });

  it("writes nothing when the verdict has no health consequence", async () => {
    const { db, updateOne } = fakeDb();
    await applyVerdict(db, classifyUpstream({ status: 400 }), { provider: "google", model: "gemini-test", fingerprint: "fp" });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("marks a credential invalid on 401", async () => {
    const { db, updateOne } = fakeDb();
    await applyVerdict(db, classifyUpstream({ status: 401 }), { provider: "nvidia", model: "laguna", fingerprint: "fp-2" });
    expect(updateOne).toHaveBeenCalledWith(
      { provider: "nvidia", fingerprint: "fp-2" },
      { $set: { authStatus: "invalid", checkedAt: expect.any(Date) } },
      { upsert: true },
    );
  });
});
