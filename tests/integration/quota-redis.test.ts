import type { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MODEL_BY_ID } from "@/lib/models/catalog";
import { startUpstashRedisFixture, type UpstashRedisFixture } from "./upstash-redis-fixture";

const profile = MODEL_BY_ID.get("google/gemini-3.6-flash")!;
const fixedNow = new Date("2026-11-03T12:00:00.000Z");
const envKeys = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "QUOTA_MODE",
  "QUOTA_CONFIG_JSON",
] as const;

let fixture: UpstashRedisFixture | undefined;
let ledger!: typeof import("@/lib/quota/ledger");
let redis: Redis | undefined;
let previousEnv: Record<string, string | undefined> = {};

function setConfig(limits: Record<string, number>) {
  process.env.QUOTA_MODE = "enforce";
  process.env.QUOTA_CONFIG_JSON = JSON.stringify({
    groups: [{ id: "integration", provider: "google", slots: [1] }],
    providers: { google: { scope: "model", timeZone: "UTC", limits } },
  });
}

function reserve(estimate: number, attemptId = `integration:${randomUUID()}`) {
  return ledger.reserveQuota({ profile, slot: 1, estimate, attemptId, now: fixedNow });
}

async function snapshot(target: Parameters<typeof ledger.getQuotaSnapshot>[0]) {
  return ledger.getQuotaSnapshot(target, fixedNow);
}

beforeAll(async () => {
  for (const key of envKeys) previousEnv[key] = process.env[key];
  const externalPort = process.env.QUOTA_REDIS_TEST_PORT
    ? Number(process.env.QUOTA_REDIS_TEST_PORT)
    : undefined;
  fixture = await startUpstashRedisFixture({ redisPort: externalPort });
  process.env.UPSTASH_REDIS_REST_URL = fixture.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "local-fixture";
  setConfig({ rpm: 5, rpd: 100, tpm: 100_000, tpd: 1_000_000 });
  ledger = await import("@/lib/quota/ledger");
  redis = (await import("@/lib/redis")).getRedis();
}, 30_000);

afterAll(async () => {
  if (redis) await redis.flushdb().catch(() => undefined);
  await fixture?.close();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(async () => {
  await redis!.flushdb();
});

describe("quota ledger against real Redis", () => {
  it("admits exactly the request limit under a concurrent burst and settles once", async () => {
    setConfig({ rpm: 5, rpd: 100, tpm: 100_000, tpd: 1_000_000 });
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => reserve(10, `request-${index}`)));
    const allowed = results.filter((result) => result.allowed);
    const denied = results.filter((result) => !result.allowed);

    expect(allowed).toHaveLength(5);
    expect(denied).toHaveLength(35);
    expect(new Set(denied.map((result) => result.reason))).toEqual(new Set(["request_minute"]));
    expect(denied.every((result) => result.retryAfterMs === 60_000)).toBe(true);

    const reservations = allowed.map((result) => result.reservation!);
    const target = reservations[0].target;
    const reserved = await snapshot(target);
    expect(reserved.used).toEqual({
      requestsDay: 5,
      requestsMinute: 5,
      tokensDay: 50,
      tokensMinute: 50,
    });
    expect(reserved.remaining.requestsMinute).toBe(0);
    expect(reserved.remaining.requestsDay).toBe(95);

    const first = reservations[0];
    const duplicateSettlements = await Promise.all(
      Array.from({ length: 5 }, () => ledger.settleQuota(first, { outcome: "completed", usage: { total: 4 } })),
    );
    expect(duplicateSettlements.filter(Boolean)).toHaveLength(1);

    const remainingSettlements = await Promise.all(
      reservations.slice(1).map((reservation) =>
        ledger.settleQuota(reservation, { outcome: "completed", usage: { total: 4 } }),
      ),
    );
    expect(remainingSettlements.every(Boolean)).toBe(true);

    const settled = await snapshot(target);
    expect(settled.used).toEqual({
      requestsDay: 5,
      requestsMinute: 5,
      tokensDay: 20,
      tokensMinute: 20,
    });
  }, 30_000);

  it("admits exactly the token budget under a concurrent burst", async () => {
    setConfig({ rpm: 100, rpd: 1_000, tpm: 100, tpd: 1_000 });
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => reserve(10, `token-${index}`)));
    const allowed = results.filter((result) => result.allowed);
    const denied = results.filter((result) => !result.allowed);

    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(30);
    expect(new Set(denied.map((result) => result.reason))).toEqual(new Set(["token_minute"]));

    const reservations = allowed.map((result) => result.reservation!);
    const target = reservations[0].target;
    const reserved = await snapshot(target);
    expect(reserved.used).toEqual({
      requestsDay: 10,
      requestsMinute: 10,
      tokensDay: 100,
      tokensMinute: 100,
    });

    const settlements = await Promise.all(
      reservations.map((reservation) =>
        ledger.settleQuota(reservation, { outcome: "completed", usage: { total: 10 } }),
      ),
    );
    expect(settlements.every(Boolean)).toBe(true);
    const settled = await snapshot(target);
    expect(settled.used.tokensDay).toBe(100);
    expect(settled.used.tokensMinute).toBe(100);
    expect(settled.used.requestsDay).toBe(10);
  }, 30_000);

  it("releases a failed attempt's token reservation without changing its request count", async () => {
    setConfig({ rpm: 5, rpd: 100, tpm: 1_000, tpd: 10_000 });
    const result = await reserve(100, "failed-attempt");
    expect(result.allowed).toBe(true);
    const reservation = result.reservation!;

    const before = await snapshot(reservation.target);
    expect(before.used.tokensDay).toBe(100);
    expect(before.used.requestsDay).toBe(1);

    await expect(ledger.settleQuota(reservation, { outcome: "failed" })).resolves.toBe(true);
    const after = await snapshot(reservation.target);
    expect(after.used.tokensDay).toBe(0);
    expect(after.used.tokensMinute).toBe(0);
    expect(after.used.requestsDay).toBe(1);
    expect(after.used.requestsMinute).toBe(1);
    await expect(ledger.settleQuota(reservation, { outcome: "failed" })).resolves.toBe(false);
  }, 30_000);
});
