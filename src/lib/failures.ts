import type { Db } from "mongodb";

export type UpstreamAction = "continue" | "stop_model" | "stop";

/**
 * One classified upstream failure.
 *
 * `reason` is the stable string written to `requests.failureStatuses`; `action`
 * tells the gateway whether another credential, another model, or no retry can
 * help. Nothing here mutates state: `applyVerdict` owns the health writes.
 */
export interface UpstreamVerdict {
  status: number | null;
  action: UpstreamAction;
  reason: string;
  retryAfterMs?: number;
  credential?: "invalid" | "exhausted";
  binding?: "unavailable" | "cooldown";
  overload?: boolean;
  /** The local quota ledger rejected this attempt; do not relabel it as an upstream 429. */
  quotaExhausted?: boolean;
}

export interface UpstreamFailureInput {
  status?: number | null;
  providerCode?: string;
  retryAfter?: string | null;
  now?: number;
}

const defaultCooldownMs = 30_000;
const maxCooldownMs = 24 * 60 * 60 * 1000;

/** Parse a Retry-After header (delta seconds or HTTP date) into a bounded delay. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number {
  if (!value) return defaultCooldownMs;
  const seconds = Number(value);
  const target = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  const delay = Number.isFinite(target) ? target - now : defaultCooldownMs;
  return Math.min(maxCooldownMs, Math.max(0, delay));
}

function reason(status: number | null, providerCode?: string) {
  const detail = (providerCode ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  if (status === null) return "transport_error";
  return detail ? `${status}:${detail}` : String(status);
}

/**
 * Map a provider response to the gateway's retry decision.
 *
 * The shape follows the documented matrix: credential faults rotate the
 * credential, missing models and exhausted quota move to the next candidate,
 * and caller/parameter faults stop without poisoning a healthy binding.
 */
export function classifyUpstream(input: UpstreamFailureInput): UpstreamVerdict {
  const now = input.now ?? Date.now();
  const status = input.status ?? null;
  const label = reason(status, input.providerCode);
  if (status === null) {
    return { status: null, action: "continue", reason: label };
  }
  if (status === 400 || status === 413 || status === 422) {
    // The upstream rejected this request shape. Retrying other credentials
    // cannot help, and the binding is not at fault.
    return { status, action: "stop_model", reason: label };
  }
  if (status === 401) return { status, action: "continue", reason: label, credential: "invalid" };
  if (status === 403) return { status, action: "continue", reason: label, credential: "invalid" };
  if (status === 402) {
    return { status, action: "continue", reason: label, credential: "exhausted", retryAfterMs: retryAfterMs(input.retryAfter, now) };
  }
  if (status === 404 || status === 410) {
    return { status, action: "stop_model", reason: label, binding: "unavailable" };
  }
  if (status === 408 || status === 425) {
    return { status, action: "continue", reason: label };
  }
  if (status === 429) {
    return { status, action: "continue", reason: label, binding: "cooldown", retryAfterMs: retryAfterMs(input.retryAfter, now) };
  }
  if (status === 503) {
    return { status, action: "stop_model", reason: label, binding: "cooldown", retryAfterMs: retryAfterMs(input.retryAfter, now), overload: true };
  }
  if (status >= 500) {
    // A per-credential 5xx may still be request-specific, so another credential
    // for the same model is tried; 503 above is the provider-wide case.
    return { status, action: "continue", reason: label, binding: "cooldown", retryAfterMs: retryAfterMs(input.retryAfter, now) };
  }
  return { status, action: "continue", reason: label };
}

export interface VerdictTarget {
  provider: string;
  model: string;
  fingerprint: string;
  now?: Date;
}

/** Persist the health consequences of a verdict. Caller keeps its own admission lease. */
export async function applyVerdict(db: Db, verdict: UpstreamVerdict, target: VerdictTarget) {
  const checkedAt = target.now ?? new Date();
  if (verdict.credential) {
    await db.collection("credential_health").updateOne(
      { provider: target.provider, fingerprint: target.fingerprint },
      { $set: { authStatus: verdict.credential === "invalid" ? "invalid" : "exhausted", checkedAt, ...(verdict.retryAfterMs ? { cooldownUntil: new Date(checkedAt.getTime() + verdict.retryAfterMs) } : {}) } },
      { upsert: true },
    );
  }
  if (verdict.binding === "unavailable") {
    await db.collection("model_bindings").updateOne(
      { provider: target.provider, model: target.model, fingerprint: target.fingerprint },
      { $set: { status: "unavailable", reason: verdict.reason, checkedAt } },
      { upsert: true },
    );
  } else if (verdict.binding === "cooldown") {
    await db.collection("model_bindings").updateOne(
      { provider: target.provider, model: target.model, fingerprint: target.fingerprint },
      { $set: { cooldownUntil: new Date(checkedAt.getTime() + (verdict.retryAfterMs ?? defaultCooldownMs)), reason: verdict.reason, checkedAt } },
      { upsert: true },
    );
  }
}

export interface FailureSummary {
  status: number;
  message: string;
  code: string;
}

/** Collapse every attempt of one request into the client-facing error. */
export function summarizeFailures(failures: UpstreamVerdict[], dispatched: number): FailureSummary {
  const statuses = failures.map((failure) => failure.status).filter((status): status is number => typeof status === "number");
  const upstreamLimited = statuses.length > 0 && statuses.every((status) => status === 429);
  const badRequest = statuses.length > 0 && statuses.every((status) => status === 400);
  const invalidOutput = failures.some((failure) => /^(invalid_|unknown_tool|.*schema_validation)/.test(failure.reason));
  if (upstreamLimited) return { status: 429, message: "Upstream quota is temporarily exhausted", code: "rate_limit_exceeded" };
  if (badRequest) return { status: 400, message: "The upstream rejected this request", code: "upstream_request_rejected" };
  if (invalidOutput) return { status: 502, message: "The upstream did not satisfy the requested output contract", code: "upstream_invalid_output" };
  if (failures.length || dispatched) return { status: 503, message: "No eligible upstream model is currently available", code: "upstream_unavailable" };
  return { status: 429, message: "No eligible upstream model is currently available", code: "rate_limit_exceeded" };
}
