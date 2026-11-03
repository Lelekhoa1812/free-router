import type { Redis } from "@upstash/redis";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MODEL_BY_ID } from "@/lib/models/catalog";
import { startUpstashRedisFixture, type UpstashRedisFixture } from "./upstash-redis-fixture";
import {
  TWO_INSTANCE_ATTEMPTS,
  TWO_INSTANCE_RESULT_PREFIX,
  type TwoInstanceResult,
} from "./worker/protocol";

const profile = MODEL_BY_ID.get("google/gemini-3.6-flash")!;
const fixedNow = new Date("2026-11-03T12:00:00.000Z");
const envKeys = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "QUOTA_MODE",
  "QUOTA_CONFIG_JSON",
] as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vitestPath = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
const workerConfigPath = path.join(repoRoot, "vitest.worker.config.ts");
const workerTestPath = "tests/integration/worker/quota-worker.test.ts";
const WORKER_TIMEOUT_MS = 25_000;

let fixture: UpstashRedisFixture | undefined;
let ledger!: typeof import("@/lib/quota/ledger");
let redis: Redis | undefined;
let previousEnv: Record<string, string | undefined> = {};

function runWorker(worker: string, run: string): Promise<void> {
  if (!existsSync(vitestPath)) throw new Error(`vitest CLI not found at ${vitestPath}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestPath, "run", "--config", workerConfigPath, workerTestPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        QUOTA_WORKER_ID: worker,
        QUOTA_TEST_RUN: run,
        QUOTA_FIXED_NOW: fixedNow.toISOString(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
    child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker ${worker} timed out\n${logs}`));
    }, WORKER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`worker ${worker} failed to start: ${error.message}\n${logs}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`worker ${worker} exited ${code ?? signal}\n${logs}`));
    });
  });
}

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

  it("shares one request and token window across two worker processes", async () => {
    setConfig({ rpm: 20, rpd: 100, tpm: 1_000, tpd: 10_000 });
    const run = randomUUID();
    // Separate child processes give each worker its own ledger module and Redis client.
    const outcomes = await Promise.allSettled([runWorker("a", run), runWorker("b", run)]);
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((failure) => failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason))),
        "two-instance quota worker failed",
      );
    }

    const values = await redis!.mget(
      `${TWO_INSTANCE_RESULT_PREFIX}${run}:a`,
      `${TWO_INSTANCE_RESULT_PREFIX}${run}:b`,
    );
    const results = values.map((value, index) => {
      if (typeof value !== "string") throw new Error(`worker ${index === 0 ? "a" : "b"} did not record a result`);
      return JSON.parse(value) as TwoInstanceResult;
    });
    expect(results).toHaveLength(2);
    expect(results.reduce((total, result) => total + result.attempts, 0)).toBe(TWO_INSTANCE_ATTEMPTS * 2);
    expect(results.reduce((total, result) => total + result.allowed, 0)).toBe(20);
    expect(results.reduce((total, result) => total + result.denied, 0)).toBe(10);
    expect(results.reduce((total, result) => total + result.settled, 0)).toBe(20);

    const { loadQuotaConfig } = await import("@/lib/quota/config");
    const target = ledger.quotaTargetFor(loadQuotaConfig().config, profile, 1);
    const shared = await snapshot(target);
    expect(shared.used).toEqual({
      requestsDay: 20,
      requestsMinute: 20,
      tokensDay: 100,
      tokensMinute: 100,
    });
  }, 40_000);
});
