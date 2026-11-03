import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ del: vi.fn(), eval: vi.fn() }));

vi.mock("@upstash/redis", () => ({ Redis: class { del = mocks.del; eval = mocks.eval; } }));
vi.mock("@/lib/env", () => ({ env: { redisUrl: "https://redis.test", redisToken: "token" } }));

import { beginLoginAttempt, clearLoginFailures } from "./redis";

describe("sign-in windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.del.mockResolvedValue(1);
    mocks.eval.mockResolvedValue(1);
  });

  it("claims the per-source and shared windows in one atomic eval", async () => {
    await expect(beginLoginAttempt("192.0.2.9")).resolves.toBe(true);

    expect(mocks.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = mocks.eval.mock.calls[0];
    expect(script).toContain("INCR");
    expect(keys).toEqual(["fr:v1:login:192.0.2.9", "fr:v1:login:global"]);
    expect(args).toEqual([5, 50]);
  });

  it("rejects an attempt when the shared window is exhausted", async () => {
    mocks.eval.mockResolvedValue(0);

    await expect(beginLoginAttempt("192.0.2.9")).resolves.toBe(false);
  });

  it("clears only the per-source window after a successful sign-in", async () => {
    await clearLoginFailures("192.0.2.9");

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith("fr:v1:login:192.0.2.9");
  });
});
