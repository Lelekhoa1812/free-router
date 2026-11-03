import type { ModelProfile, Provider } from "@/lib/models/catalog";
import type { UpstreamVerdict } from "@/lib/failures";
import { getRedis } from "@/lib/redis";
import { loadQuotaConfig, type QuotaConfig, type QuotaGroup, type QuotaLimit, type QuotaMode, type QuotaScope } from "./config";
import { quotaPeriod, type QuotaPeriod } from "./period";

export interface QuotaTarget {
  provider: Provider;
  group: string;
  model: string;
  scope: QuotaScope;
  limits: QuotaLimit;
  timeZone: string;
}

export interface QuotaReservation {
  id: string;
  target: QuotaTarget;
  estimate: number;
  mode: QuotaMode;
  keys: string[];
  resetAt: Date;
  minuteResetSeconds: number;
  dayResetSeconds: number;
  dayTtl: number;
}

export interface ReserveResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
  reservation?: QuotaReservation;
  unavailable?: boolean;
}

export type SettlementOutcome = "completed" | "failed" | "cancelled" | "pre_dispatch";

export interface QuotaSnapshot {
  available: boolean;
  used: {
    requestsDay: number;
    requestsMinute: number;
    tokensDay: number;
    tokensMinute: number;
  };
  remaining: {
    requestsDay: number | null;
    requestsMinute: number | null;
    tokensDay: number | null;
    tokensMinute: number | null;
  };
  resetAt: string | null;
}

const RESERVE_SCRIPT = `
local dayReq=tonumber(redis.call('GET',KEYS[1]) or '0')
local minReq=tonumber(redis.call('GET',KEYS[2]) or '0')
local dayTok=tonumber(redis.call('GET',KEYS[3]) or '0')
local minTok=tonumber(redis.call('GET',KEYS[4]) or '0')
local rpm=tonumber(ARGV[1])
local rpd=tonumber(ARGV[2])
local tpm=tonumber(ARGV[3])
local tpd=tonumber(ARGV[4])
local est=tonumber(ARGV[5])
local enforce=tonumber(ARGV[6])
local code=''
if rpm>0 and minReq>=rpm then code='request_minute'
elseif rpd>0 and dayReq>=rpd then code='request_day'
elseif tpm>0 and minTok+est>tpm then code='token_minute'
elseif tpd>0 and dayTok+est>tpd then code='token_day'
end
local retry='0'
if code~='' then
  retry=ARGV[7]
  if code=='request_day' or code=='token_day' then retry=ARGV[8] end
end
if code~='' and enforce==1 then return {0,code,retry,dayReq,dayTok} end
redis.call('INCR',KEYS[1])
redis.call('INCR',KEYS[2])
if est>0 then redis.call('INCRBY',KEYS[3],est); redis.call('INCRBY',KEYS[4],est) end
redis.call('EXPIRE',KEYS[1],ARGV[9])
redis.call('EXPIRE',KEYS[2],ARGV[10])
redis.call('EXPIRE',KEYS[3],ARGV[9])
redis.call('EXPIRE',KEYS[4],ARGV[10])
return {1,code,retry,dayReq+1,dayTok+est}
`;

const SETTLE_SCRIPT = `
if not redis.call('SET',KEYS[5],'1','NX','EX',ARGV[3]) then return 0 end
local delta=tonumber(ARGV[1])
if delta~=0 then
  for i=3,4 do
    local n=tonumber(redis.call('INCRBY',KEYS[i],delta) or '0')
    if n<0 then redis.call('SET',KEYS[i],0) end
    redis.call('EXPIRE',KEYS[i],ARGV[4])
  end
end
return 1
`;

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
}

function integer(value: number): number {
  return Math.max(0, Math.round(value));
}

function limitValue(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : -1;
}

function targetKey(target: QuotaTarget): string {
  return target.scope === "model"
    ? `${safe(target.provider)}:${safe(target.group)}:${safe(target.model)}`
    : `${safe(target.provider)}:${safe(target.group)}:all`;
}

export function quotaKeys(target: QuotaTarget, period: QuotaPeriod): string[] {
  const base = targetKey(target);
  return [
    `fr:v1:quota:req:d:${base}:${period.day}`,
    `fr:v1:quota:req:m:${base}:${period.minute}`,
    `fr:v1:quota:tok:d:${base}:${period.day}`,
    `fr:v1:quota:tok:m:${base}:${period.minute}`,
  ];
}

/** Build a target for a concrete configured group. */
export function quotaTarget(config: QuotaConfig, provider: Provider, group: QuotaGroup, model: string): QuotaTarget {
  const providerConfig = config.providers[provider];
  const modelLimit = model !== "*" ? providerConfig.models?.[model] : undefined;
  return {
    provider,
    group: group.id,
    model,
    scope: providerConfig.scope,
    limits: { ...providerConfig.limits, ...(modelLimit ?? {}) },
    timeZone: providerConfig.timeZone,
  };
}

export function quotaTargetFor(config: QuotaConfig, profile: ModelProfile, slot: number): QuotaTarget {
  const group = config.groups.find((candidate) => candidate.provider === profile.provider && candidate.slots.includes(slot)) ?? {
    id: "default",
    provider: profile.provider,
    slots: [],
  };
  return quotaTarget(config, profile.provider, group, profile.id);
}

function makeReservation(
  target: QuotaTarget,
  estimate: number,
  mode: QuotaMode,
  attemptId: string,
  period: QuotaPeriod,
): QuotaReservation {
  return {
    id: attemptId,
    target,
    estimate,
    mode,
    keys: quotaKeys(target, period),
    resetAt: period.resetAt,
    minuteResetSeconds: period.minuteResetSeconds,
    dayResetSeconds: period.dayResetSeconds,
    dayTtl: Math.max(3_600, period.dayResetSeconds + 3_600),
  };
}

/**
 * Atomically check and consume the request/token windows.
 *
 * The reservation is the estimate. Settlement later adjusts the token counters
 * to the provider-reported or content-derived total. A process that dies before
 * settlement leaves the conservative estimate charged, never an undercount.
 */
export async function reserveQuota(input: {
  profile: ModelProfile;
  slot: number;
  estimate: number;
  attemptId: string;
  now?: Date;
}): Promise<ReserveResult> {
  const loaded = loadQuotaConfig();
  const mode = loaded.config.mode;
  if (mode === "off") return { allowed: true };
  if (!loaded.valid && mode === "enforce") throw new Error("quota_config_invalid");

  const target = quotaTargetFor(loaded.config, input.profile, input.slot);
  const period = quotaPeriod(target.timeZone, input.now ?? new Date());
  const estimate = integer(input.estimate);
  const keys = quotaKeys(target, period);
  try {
    const result = (await getRedis().eval(
      RESERVE_SCRIPT,
      keys,
      [
        String(limitValue(target.limits.rpm)),
        String(limitValue(target.limits.rpd)),
        String(limitValue(target.limits.tpm)),
        String(limitValue(target.limits.tpd)),
        String(estimate),
        mode === "enforce" ? "1" : "0",
        String(period.minuteResetSeconds),
        String(period.dayResetSeconds),
        String(Math.max(3_600, period.dayResetSeconds + 3_600)),
        "120",
      ],
    )) as Array<number | string>;
    const allowed = Number(result[0]) === 1;
    const reason = String(result[1] || "") || undefined;
    const retryAfter = Number(result[2] || 0);
    return {
      allowed,
      ...(reason ? { reason } : {}),
      ...(retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
      ...(allowed ? { reservation: makeReservation(target, estimate, mode, input.attemptId, period) } : {}),
    };
  } catch (error) {
    if (mode === "enforce") throw error;
    // Observation must never take the gateway down when Redis is absent.
    return { allowed: true, unavailable: true };
  }
}

/**
 * Adjust the token reservation to the actual usage (or release it on a failed
 * attempt). The settlement marker makes stream completion, cancellation and
 * error cleanup idempotent.
 */
export async function settleQuota(
  reservation: QuotaReservation | undefined,
  settlement: { outcome: SettlementOutcome; usage?: { total?: number } | null },
): Promise<boolean> {
  if (!reservation || reservation.mode === "off") return false;
  const actual = settlement.usage?.total;
  const delta =
    actual !== undefined
      ? integer(actual) - reservation.estimate
      : settlement.outcome === "completed"
        ? 0
        : -reservation.estimate;
  try {
    const result = await getRedis().eval(
      SETTLE_SCRIPT,
      [...reservation.keys, `fr:v1:quota:settled:${safe(reservation.id)}`],
      [String(delta), String(reservation.estimate), "3600", String(reservation.dayTtl)],
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
}

export async function getQuotaSnapshot(target: QuotaTarget, now: Date = new Date()): Promise<QuotaSnapshot> {
  const period = quotaPeriod(target.timeZone, now);
  const keys = quotaKeys(target, period);
  try {
    const values = (await getRedis().mget(...keys)) as Array<number | string | null>;
    const used = {
      requestsDay: Number(values[0] ?? 0),
      requestsMinute: Number(values[1] ?? 0),
      tokensDay: Number(values[2] ?? 0),
      tokensMinute: Number(values[3] ?? 0),
    };
    const remaining = {
      requestsDay: target.limits.rpd ? Math.max(0, target.limits.rpd - used.requestsDay) : null,
      requestsMinute: target.limits.rpm ? Math.max(0, target.limits.rpm - used.requestsMinute) : null,
      tokensDay: target.limits.tpd ? Math.max(0, target.limits.tpd - used.tokensDay) : null,
      tokensMinute: target.limits.tpm ? Math.max(0, target.limits.tpm - used.tokensMinute) : null,
    };
    return { available: true, used, remaining, resetAt: period.resetAt.toISOString() };
  } catch {
    return {
      available: false,
      used: { requestsDay: 0, requestsMinute: 0, tokensDay: 0, tokensMinute: 0 },
      remaining: { requestsDay: null, requestsMinute: null, tokensDay: null, tokensMinute: null },
      resetAt: null,
    };
  }
}

export function quotaVerdict(reason: string | undefined, retryAfterMs: number | undefined): UpstreamVerdict {
  return {
    status: 429,
    action: "continue",
    reason: `429:quota_${reason ?? "exhausted"}`,
    ...(retryAfterMs ? { retryAfterMs } : {}),
    quotaExhausted: true,
  };
}

export function quotaFailure(failures: UpstreamVerdict[]): UpstreamVerdict | undefined {
  return [...failures].reverse().find((failure) => failure.quotaExhausted);
}
