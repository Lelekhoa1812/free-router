import type { Db } from "mongodb";

export const MODEL_OVERLOAD_BASE_MS = 30_000;
export const MODEL_OVERLOAD_MAX_MS = 5 * 60_000;
export const MODEL_OVERLOAD_FAILURE_WINDOW_MS = 10 * 60_000;
export const MODEL_OVERLOAD_STATE_TTL_MS = 15 * 60_000;

export type ModelOverloadState = {
  provider: string;
  model: string;
  failures: number;
  lastFailureAt: Date;
  cooldownUntil: Date;
  expiresAt: Date;
};

/** Pure transition used by deterministic tests and as the documented breaker policy. */
export function nextModelOverloadState(
  previous: Pick<ModelOverloadState, "failures" | "lastFailureAt"> | null | undefined,
  provider: string,
  model: string,
  now: Date,
): ModelOverloadState {
  const recent = previous && now.getTime() - new Date(previous.lastFailureAt).getTime() <= MODEL_OVERLOAD_FAILURE_WINDOW_MS;
  const failures = recent ? Math.min(5, Math.max(1, previous.failures) + 1) : 1;
  const cooldownMs = Math.min(MODEL_OVERLOAD_MAX_MS, MODEL_OVERLOAD_BASE_MS * 2 ** (failures - 1));
  return {
    provider,
    model,
    failures,
    lastFailureAt: new Date(now),
    cooldownUntil: new Date(now.getTime() + cooldownMs),
    expiresAt: new Date(now.getTime() + MODEL_OVERLOAD_STATE_TTL_MS),
  };
}

export function isModelCoolingDown(state: { cooldownUntil?: Date | string } | null | undefined, now: Date): boolean {
  return Boolean(state?.cooldownUntil && new Date(state.cooldownUntil).getTime() > now.getTime());
}

/**
 * Persist a model-wide 503 breaker transition atomically. The unique provider/model
 * key keeps state bounded to the configured model inventory; TTL reclaims old state.
 */
export async function recordModelOverload(db: Db, provider: string, model: string, now = new Date()): Promise<void> {
  const failureWindowStart = new Date(now.getTime() - MODEL_OVERLOAD_FAILURE_WINDOW_MS);
  await db.collection("model_overload_breakers").updateOne(
    { provider, model },
    [
      {
        $set: {
          provider: { $literal: provider },
          model: { $literal: model },
          failures: {
            $cond: [
              { $gt: ["$lastFailureAt", failureWindowStart] },
              { $min: [5, { $add: [{ $ifNull: ["$failures", 0] }, 1] }] },
              1,
            ],
          },
          lastFailureAt: { $literal: now },
        },
      },
      {
        $set: {
          cooldownUntil: {
            $dateAdd: {
              startDate: { $literal: now },
              unit: "millisecond",
              amount: {
                $min: [
                  MODEL_OVERLOAD_MAX_MS,
                  { $multiply: [MODEL_OVERLOAD_BASE_MS, { $pow: [2, { $subtract: ["$failures", 1] }] }] },
                ],
              },
            },
          },
          expiresAt: { $literal: new Date(now.getTime() + MODEL_OVERLOAD_STATE_TTL_MS) },
        },
      },
    ],
    { upsert: true },
  );
}

export async function isPersistedModelCoolingDown(db: Db, provider: string, model: string, now = new Date()): Promise<boolean> {
  const state = await db.collection("model_overload_breakers").findOne(
    { provider, model, cooldownUntil: { $gt: now } },
    { projection: { _id: 1 } },
  );
  return Boolean(state);
}

/** A successful upstream response is the recovery signal that clears the shared breaker. */
export async function clearModelOverload(db: Db, provider: string, model: string, requestStartedAt: Date): Promise<void> {
  // An older in-flight success must not erase a newer concurrent 503 transition.
  await db.collection("model_overload_breakers").deleteOne({ provider, model, lastFailureAt: { $lte: requestStartedAt } });
}
