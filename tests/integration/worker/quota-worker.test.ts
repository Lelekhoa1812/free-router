import { describe, expect, it } from "vitest";
import { MODEL_BY_ID } from "@/lib/models/catalog";
import { loadQuotaConfig } from "@/lib/quota/config";
import { reserveQuota, settleQuota } from "@/lib/quota/ledger";
import { getRedis } from "@/lib/redis";
import {
  TWO_INSTANCE_ATTEMPTS,
  TWO_INSTANCE_READY_PREFIX,
  TWO_INSTANCE_RESULT_PREFIX,
  type TwoInstanceResult,
} from "./protocol";

const profile = MODEL_BY_ID.get("google/gemini-3.6-flash")!;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the two-instance worker`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("two-instance quota worker", () => {
  it("races the shared window and records its local result", async () => {
    const worker = required("QUOTA_WORKER_ID");
    const run = required("QUOTA_TEST_RUN");
    const now = new Date(required("QUOTA_FIXED_NOW"));
    if (Number.isNaN(now.getTime())) throw new Error("QUOTA_FIXED_NOW is not a valid date");

    const loaded = loadQuotaConfig();
    if (!loaded.valid) throw new Error(`worker quota config is invalid: ${loaded.warnings.join(", ")}`);

    const redis = getRedis();
    const readyKey = `${TWO_INSTANCE_READY_PREFIX}${run}`;
    await redis.incr(readyKey);
    await redis.expire(readyKey, 60);

    const deadline = Date.now() + 10_000;
    while (Number(await redis.get(readyKey)) < 2) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the second quota worker");
      await sleep(50);
    }

    const results = await Promise.all(
      Array.from({ length: TWO_INSTANCE_ATTEMPTS }, (_, index) =>
        reserveQuota({
          profile,
          slot: 1,
          estimate: 10,
          attemptId: `two-instance:${worker}:${index}`,
          now,
        }),
      ),
    );
    const allowed = results.filter((result) => result.allowed);
    const denied = results.filter((result) => !result.allowed);
    const settlements = await Promise.all(
      allowed.map((result) =>
        settleQuota(result.reservation, { outcome: "completed", usage: { total: 5 } }),
      ),
    );

    const output: TwoInstanceResult = {
      worker,
      attempts: results.length,
      allowed: allowed.length,
      denied: denied.length,
      settled: settlements.filter(Boolean).length,
    };
    await redis.set(`${TWO_INSTANCE_RESULT_PREFIX}${run}:${worker}`, JSON.stringify(output), { ex: 60 });

    expect(results).toHaveLength(TWO_INSTANCE_ATTEMPTS);
    expect(output.settled).toBe(output.allowed);
  }, 30_000);
});
