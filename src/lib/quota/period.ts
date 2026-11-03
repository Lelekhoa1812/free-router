const formatterCache = new Map<string, Intl.DateTimeFormat>();
const resetCache = new Map<string, { day: string; resetAt: number }>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Calendar day in the provider's reset time zone, as YYYY-MM-DD. */
export function quotaDayKey(timeZone: string, now: Date = new Date()): string {
  const parts = formatter(timeZone).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * First millisecond of the next provider-local calendar day.
 *
 * A one-minute binary search handles DST and half-hour offsets without a date
 * library. The result is cached per time zone until that local day changes.
 */
export function quotaResetAt(timeZone: string, now: Date = new Date()): Date {
  const day = quotaDayKey(timeZone, now);
  const cached = resetCache.get(timeZone);
  if (cached?.day === day) return new Date(cached.resetAt);

  let low = now.getTime();
  let high = low + 36 * 3_600_000;
  while (quotaDayKey(timeZone, new Date(high)) === day && high - low < 48 * 3_600_000) high += 6 * 3_600_000;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (quotaDayKey(timeZone, new Date(mid)) === day) low = mid;
    else high = mid;
  }
  resetCache.set(timeZone, { day, resetAt: high });
  return new Date(high);
}

export interface QuotaPeriod {
  day: string;
  minute: number;
  resetAt: Date;
  dayResetSeconds: number;
  minuteResetSeconds: number;
}

/** Current day/minute keys plus the bounded Retry-After values for each window. */
export function quotaPeriod(timeZone: string, now: Date = new Date()): QuotaPeriod {
  const resetAt = quotaResetAt(timeZone, now);
  const timestamp = now.getTime();
  const minute = Math.floor(timestamp / 60_000);
  return {
    day: quotaDayKey(timeZone, now),
    minute,
    resetAt,
    dayResetSeconds: Math.max(1, Math.ceil((resetAt.getTime() - timestamp) / 1000)),
    minuteResetSeconds: Math.max(1, Math.ceil((60_000 - (timestamp % 60_000)) / 1000)),
  };
}

/** Used by tests that need a deterministic midnight without fake timers. */
export function clearQuotaPeriodCache() {
  formatterCache.clear();
  resetCache.clear();
}
