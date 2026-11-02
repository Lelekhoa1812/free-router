import { describe, expect, it } from "vitest";
import {
  MODEL_OVERLOAD_BASE_MS,
  MODEL_OVERLOAD_FAILURE_WINDOW_MS,
  MODEL_OVERLOAD_MAX_MS,
  MODEL_OVERLOAD_STATE_TTL_MS,
  isModelCoolingDown,
  nextModelOverloadState,
} from "./overload-breaker";

describe("shared model overload breaker policy", () => {
  const start = new Date("2026-11-03T00:00:00.000Z");

  it("opens for 30 seconds after the first 503 and expires at the boundary", () => {
    const state = nextModelOverloadState(null, "google", "gemini-test", start);
    expect(state.failures).toBe(1);
    expect(state.cooldownUntil.getTime() - start.getTime()).toBe(MODEL_OVERLOAD_BASE_MS);
    expect(isModelCoolingDown(state, new Date(start.getTime() + MODEL_OVERLOAD_BASE_MS - 1))).toBe(true);
    expect(isModelCoolingDown(state, new Date(start.getTime() + MODEL_OVERLOAD_BASE_MS))).toBe(false);
    expect(state.expiresAt.getTime() - start.getTime()).toBe(MODEL_OVERLOAD_STATE_TTL_MS);
  });

  it("uses bounded exponential backoff for repeated model-wide overloads", () => {
    let state = nextModelOverloadState(null, "google", "gemini-test", start);
    const delays: number[] = [state.cooldownUntil.getTime() - start.getTime()];
    for (let count = 2; count <= 8; count++) {
      const now = new Date(start.getTime() + count * 1000);
      state = nextModelOverloadState(state, "google", "gemini-test", now);
      delays.push(state.cooldownUntil.getTime() - now.getTime());
    }
    expect(delays.slice(0, 5)).toEqual([30_000, 60_000, 120_000, 240_000, MODEL_OVERLOAD_MAX_MS]);
    expect(delays.slice(5)).toEqual([MODEL_OVERLOAD_MAX_MS, MODEL_OVERLOAD_MAX_MS, MODEL_OVERLOAD_MAX_MS]);
    expect(state.failures).toBe(5);
    expect(MODEL_OVERLOAD_MAX_MS).toBe(300_000);
  });

  it("resets the backoff after a quiet failure window", () => {
    const previous = nextModelOverloadState(null, "google", "gemini-test", start);
    const now = new Date(start.getTime() + MODEL_OVERLOAD_FAILURE_WINDOW_MS + 1);
    const recovered = nextModelOverloadState(previous, "google", "gemini-test", now);
    expect(recovered.failures).toBe(1);
    expect(recovered.cooldownUntil.getTime() - now.getTime()).toBe(MODEL_OVERLOAD_BASE_MS);
  });

  it("keeps overload state scoped by the provider/model identity and temporary", () => {
    const state = nextModelOverloadState(null, "google", "gemini-test", start);
    expect(state).toMatchObject({ provider: "google", model: "gemini-test" });
    expect(isModelCoolingDown({ cooldownUntil: new Date(start.getTime() - 1) }, start)).toBe(false);
  });
});
