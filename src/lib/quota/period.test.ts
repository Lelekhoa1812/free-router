import { beforeEach, describe, expect, it } from "vitest";
import { clearQuotaPeriodCache, quotaDayKey, quotaPeriod, quotaResetAt } from "./period";

beforeEach(() => clearQuotaPeriodCache());

describe("quota periods", () => {
  it("uses UTC midnight and a one-minute Retry-After at the boundary", () => {
    const now = new Date("2026-11-03T23:59:00.000Z");
    expect(quotaDayKey("UTC", now)).toBe("2026-11-03");
    expect(quotaResetAt("UTC", now).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    const period = quotaPeriod("UTC", now);
    expect(period.dayResetSeconds).toBe(60);
    expect(period.minuteResetSeconds).toBe(60);
  });

  it("resets Google at midnight Pacific, not UTC", () => {
    const beforeMidnight = new Date("2026-11-03T07:30:00.000Z");
    expect(quotaDayKey("America/Los_Angeles", beforeMidnight)).toBe("2026-11-02");
    expect(quotaResetAt("America/Los_Angeles", beforeMidnight).toISOString()).toBe("2026-11-03T08:00:00.000Z");

    const midnight = new Date("2026-11-03T08:00:00.000Z");
    expect(quotaDayKey("America/Los_Angeles", midnight)).toBe("2026-11-03");
    expect(quotaResetAt("America/Los_Angeles", midnight).toISOString()).toBe("2026-11-04T08:00:00.000Z");
  });

  it("handles the spring DST transition without a fixed 24-hour offset", () => {
    const now = new Date("2026-03-08T09:30:00.000Z");
    expect(quotaDayKey("America/Los_Angeles", now)).toBe("2026-03-08");
    expect(quotaResetAt("America/Los_Angeles", now).toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("returns the remaining seconds in the current minute", () => {
    const period = quotaPeriod("UTC", new Date("2026-11-03T12:34:30.500Z"));
    expect(period.minuteResetSeconds).toBe(30);
  });
});
