import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_BY_ID } from "@/lib/models/catalog";

const mocks = vi.hoisted(() => ({ getRedis: vi.fn() }));

vi.mock("@/lib/redis", () => ({ getRedis: mocks.getRedis }));

import { loadQuotaConfig } from "./config";
import {
  getQuotaSnapshot,
  quotaFailure,
  quotaTargetFor,
  quotaVerdict,
  reserveQuota,
  settleQuota,
} from "./ledger";

const profile = MODEL_BY_ID.get("google/gemini-3.6-flash")!;
const redis = { eval: vi.fn(), mget: vi.fn() };
let previousMode: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  previousMode = process.env.QUOTA_MODE;
  process.env.QUOTA_MODE = "enforce";
  mocks.getRedis.mockReturnValue(redis);
});

afterEach(() => {
  if (previousMode === undefined) delete process.env.QUOTA_MODE;
  else process.env.QUOTA_MODE = previousMode;
});

describe("quota ledger", () => {
  it("reserves request and token windows in one eval", async () => {
    redis.eval.mockResolvedValue([1, "", 0, 1, 100]);
    const result = await reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:1" });
    expect(result.allowed).toBe(true);
    expect(result.reservation?.keys).toHaveLength(4);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = redis.eval.mock.calls[0];
    expect(script).toContain("INCRBY");
    expect(keys[0]).toContain("fr:v1:quota:req:d:google:default");
    expect(args.slice(0, 6)).toEqual(["5", "-1", "-1", "-1", "100", "1"]);
  });

  it("rejects an exhausted daily request window with a bounded retry", async () => {
    redis.eval.mockResolvedValue([0, "request_day", 120, 20, 0]);
    const result = await reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:2" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("request_day");
    expect(result.retryAfterMs).toBe(120_000);
    expect(result.reservation).toBeUndefined();
  });

  it("keeps observation allowed while reporting what would have been denied", async () => {
    process.env.QUOTA_MODE = "observe";
    redis.eval.mockResolvedValue([1, "token_minute", 30, 1, 100]);
    const result = await reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:3" });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("token_minute");
    expect(result.reservation).toBeDefined();
  });

  it("does not take observation down when Redis is unavailable", async () => {
    process.env.QUOTA_MODE = "observe";
    redis.eval.mockRejectedValue(new Error("redis down"));
    await expect(reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:4" })).resolves.toMatchObject({ allowed: true, unavailable: true });
  });

  it("fails closed in enforce mode when Redis is unavailable", async () => {
    redis.eval.mockRejectedValue(new Error("redis down"));
    await expect(reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:5" })).rejects.toThrow("redis down");
  });

  it("settles an attempt once and adjusts the token reservation", async () => {
    redis.eval.mockResolvedValueOnce([1, "", 0, 1, 100]).mockResolvedValueOnce(1);
    const result = await reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:6" });
    await expect(settleQuota(result.reservation, { outcome: "completed", usage: { total: 80 } })).resolves.toBe(true);
    const [script, keys, args] = redis.eval.mock.calls[1];
    expect(script).toContain("SET");
    expect(keys[4]).toContain("fr:v1:quota:settled:fr_test:6");
    expect(args[0]).toBe("-20");
  });

  it("treats a duplicate settlement as a no-op", async () => {
    redis.eval.mockResolvedValueOnce([1, "", 0, 1, 100]).mockResolvedValueOnce(0);
    const result = await reserveQuota({ profile, slot: 1, estimate: 100, attemptId: "fr_test:7" });
    await expect(settleQuota(result.reservation, { outcome: "completed" })).resolves.toBe(false);
  });

  it("reads remaining headroom and reset time", async () => {
    redis.mget.mockResolvedValue([10, 2, 300, 40]);
    const target = quotaTargetFor(loadQuotaConfig().config, profile, 1);
    const snapshot = await getQuotaSnapshot(target, new Date("2026-11-03T12:00:00.000Z"));
    expect(snapshot.available).toBe(true);
    expect(snapshot.used.requestsDay).toBe(10);
    expect(snapshot.remaining.requestsMinute).toBe(3);
    expect(snapshot.remaining.requestsDay).toBeNull();
    expect(snapshot.resetAt).toContain("2026-11-04T08:00:00.000Z");
  });

  it("exposes quota failures distinctly from upstream 429s", () => {
    const verdict = quotaVerdict("request_day", 60_000);
    expect(verdict).toMatchObject({ status: 429, quotaExhausted: true, retryAfterMs: 60_000 });
    expect(quotaFailure([verdict])).toBe(verdict);
    expect(quotaFailure([])).toBeUndefined();
  });
});
