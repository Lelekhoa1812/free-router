import { z } from "zod";
import { providers } from "@/lib/env";
import type { Provider } from "@/lib/models/catalog";
import { isValidTimeZone } from "./period";

export type QuotaMode = "off" | "observe" | "enforce";
export type QuotaScope = "group" | "model";

export interface QuotaLimit {
  /** Requests per minute. Zero or absent means unconfigured. */
  rpm?: number;
  /** Requests per provider-local day. Zero or absent means unconfigured. */
  rpd?: number;
  /** Input tokens per minute. */
  tpm?: number;
  /** Tokens per provider-local day. */
  tpd?: number;
}

export interface QuotaProviderConfig {
  scope: QuotaScope;
  timeZone: string;
  limits: QuotaLimit;
  models?: Record<string, QuotaLimit>;
}

export interface QuotaGroup {
  id: string;
  provider: Provider;
  slots: number[];
  label?: string;
}

export interface QuotaConfig {
  mode: QuotaMode;
  groups: QuotaGroup[];
  providers: Record<Provider, QuotaProviderConfig>;
}

export interface QuotaConfigResult {
  config: QuotaConfig;
  warnings: string[];
  valid: boolean;
}

const PROVIDER_IDS = [
  "google",
  "nvidia",
  "openrouter",
  "matilda",
  "zenmux",
  "orcarouter",
  "mistral",
  "tokenharbor",
  "groq",
  "novita",
  "hyperbolic",
  "inference",
  "azure",
] as const satisfies readonly Provider[];

const PROVIDER_COUNT = new Map(providers.map((provider) => [provider.id, provider.count]));
const PROVIDER_LABEL = new Map(providers.map((provider) => [provider.id, provider.label]));

export const DEFAULT_PROVIDER_CONFIG: Record<Provider, QuotaProviderConfig> = {
  google: {
    scope: "model",
    timeZone: "America/Los_Angeles",
    // The public per-model table is gone. Five RPM is a conservative safety
    // default; operators should enter the current AI Studio limits.
    limits: { rpm: 5 },
  },
  nvidia: {
    scope: "model",
    timeZone: "UTC",
    // NVIDIA staff acknowledge a real-world ~40 RPM cap but publish no
    // per-model limit or reset contract.
    limits: { rpm: 40 },
  },
  openrouter: {
    scope: "group",
    timeZone: "UTC",
    // Free models: 20 RPM and 50 RPD by default; 1,000 RPD after enough
    // all-time credits. The daily counter is account-wide.
    limits: { rpm: 20, rpd: 50 },
  },
  matilda: {
    scope: "model",
    timeZone: "UTC",
    // Matilda has request-size limits rather than a documented free-tier
    // daily quota. Keep a conservative request guard.
    limits: { rpm: 5 },
  },
  zenmux: {
    scope: "group",
    timeZone: "UTC",
    // Unified free tier guard; operators configure real account bounds.
    limits: { rpm: 20 },
  },
  orcarouter: {
    scope: "group",
    timeZone: "UTC",
    // Unified free tier guard; operators configure real account bounds.
    limits: { rpm: 20 },
  },
  mistral: {
    scope: "model",
    timeZone: "UTC",
    // Conservative local guard; operators should configure account and model limits.
    limits: { rpm: 5 },
  },
  tokenharbor: {
    scope: "group",
    timeZone: "UTC",
    // Unified free tier guard; operators configure real account bounds.
    limits: { rpm: 20 },
  },
  groq: {
    scope: "model",
    timeZone: "UTC",
    // Groq Free tier: 30 RPM, ~6K TPM, 14.4K RPD
    limits: { rpm: 30 },
  },
  novita: {
    scope: "group",
    timeZone: "UTC",
    // Novita AI Free tier: 30 RPM, 50M TPM for free models
    limits: { rpm: 30 },
  },
  hyperbolic: {
    scope: "model",
    timeZone: "UTC",
    // Hyperbolic Free tier (phone verified): 60 RPM
    limits: { rpm: 60 },
  },
  inference: {
    scope: "group",
    timeZone: "UTC",
    // Inference.net Free tier: 30 RPM, 1M req/mo
    limits: { rpm: 30 },
  },
  azure: {
    scope: "model",
    timeZone: "UTC",
    // Azure OpenAI Free Tier: Fixed quotas, no increases
    limits: { rpm: 5 },
  },
};

const limitSchema = z
  .object({
    rpm: z.number().int().min(0).max(60_000).optional(),
    rpd: z.number().int().min(0).max(1_000_000).optional(),
    tpm: z.number().int().min(0).max(1_000_000_000).optional(),
    tpd: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();

const providerSchema = z
  .object({
    scope: z.enum(["group", "model"]).optional(),
    timeZone: z.string().min(1).max(64).optional(),
    limits: limitSchema.optional(),
    models: z.record(z.string().min(1).max(200), limitSchema).optional(),
  })
  .strict();

const groupSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    provider: z.enum(PROVIDER_IDS),
    slots: z.array(z.number().int().min(1).max(9)).min(1).max(9),
    label: z.string().min(1).max(80).optional(),
  })
  .strict();

const configSchema = z
  .object({
    mode: z.enum(["off", "observe", "enforce"]).optional(),
    groups: z.array(groupSchema).max(64).optional(),
    providers: z.record(z.string(), providerSchema).optional(),
  })
  .strict();

function defaultGroups(): QuotaGroup[] {
  return PROVIDER_IDS.map((provider) => ({
    id: "default",
    provider,
    slots: Array.from({ length: PROVIDER_COUNT.get(provider) ?? 9 }, (_, index) => index + 1),
    label: `${PROVIDER_LABEL.get(provider) ?? provider} default account`,
  }));
}

function defaultProviderConfig(): Record<Provider, QuotaProviderConfig> {
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [
      provider,
      {
        ...DEFAULT_PROVIDER_CONFIG[provider],
        limits: { ...DEFAULT_PROVIDER_CONFIG[provider].limits },
        ...(DEFAULT_PROVIDER_CONFIG[provider].models
          ? { models: Object.fromEntries(Object.entries(DEFAULT_PROVIDER_CONFIG[provider].models!).map(([id, limit]) => [id, { ...limit }])) }
          : {}),
      },
    ]),
  ) as Record<Provider, QuotaProviderConfig>;
}

function normalizeGroups(rawGroups: z.infer<typeof groupSchema>[] | undefined): QuotaGroup[] {
  const groups: QuotaGroup[] = rawGroups
    ? rawGroups.map((group) => ({
        id: group.id,
        provider: group.provider,
        slots: [...group.slots],
        ...(group.label ? { label: group.label } : {}),
      }))
    : defaultGroups();

  for (const provider of PROVIDER_IDS) {
    const providerGroups = groups.filter((group) => group.provider === provider);
    const ids = new Set<string>();
    const assigned = new Set<number>();
    for (const group of providerGroups) {
      if (ids.has(group.id)) throw new Error(`duplicate quota group ${provider}:${group.id}`);
      ids.add(group.id);
      for (const slot of group.slots) {
        if (assigned.has(slot)) throw new Error(`quota slot ${provider}:${slot} is assigned twice`);
        assigned.add(slot);
      }
    }
    const count = PROVIDER_COUNT.get(provider) ?? 9;
    const missing = Array.from({ length: count }, (_, index) => index + 1).filter((slot) => !assigned.has(slot));
    if (missing.length) {
      const fallback = providerGroups.find((group) => group.id === "default");
      if (fallback) fallback.slots.push(...missing);
      else
        groups.push({
          id: "default",
          provider,
          slots: missing,
          label: `${PROVIDER_LABEL.get(provider) ?? provider} default account`,
        });
    }
  }
  return groups;
}

function mergeProviderConfig(
  defaults: Record<Provider, QuotaProviderConfig>,
  rawProviders: z.infer<typeof configSchema>["providers"],
): Record<Provider, QuotaProviderConfig> {
  const merged = defaults;
  for (const [provider, raw] of Object.entries(rawProviders ?? {})) {
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) throw new Error(`unknown provider ${provider}`);
    const key = provider as Provider;
    const current = merged[key];
    merged[key] = {
      ...current,
      ...(raw.scope ? { scope: raw.scope } : {}),
      ...(raw.timeZone ? { timeZone: raw.timeZone } : {}),
      limits: { ...current.limits, ...(raw.limits ?? {}) },
      ...(raw.models
        ? {
            models: Object.fromEntries(
              Object.entries(raw.models).map(([model, limit]) => [model, { ...(current.models?.[model] ?? {}), ...limit }]),
            ),
          }
        : current.models
          ? { models: current.models }
          : {}),
    };
  }
  for (const provider of PROVIDER_IDS) {
    if (!isValidTimeZone(merged[provider].timeZone)) throw new Error(`invalid time zone for ${provider}: ${merged[provider].timeZone}`);
  }
  return merged;
}

function resolveModeOverride(modeOverride?: string): QuotaMode | undefined {
  if (!modeOverride) return undefined;
  const parsed = configSchema.shape.mode.safeParse(modeOverride);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse a quota config object. Invalid configuration returns conservative
 * defaults plus a warning instead of enforcing a half-valid policy. A valid
 * mode override survives an invalid payload so enforce still fails closed.
 */
export function parseQuotaConfig(raw: unknown, modeOverride?: string): QuotaConfigResult {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: { mode: resolveModeOverride(modeOverride) ?? "observe", groups: defaultGroups(), providers: defaultProviderConfig() },
      warnings: ["quota_config_invalid"],
      valid: false,
    };
  }
  try {
    const providers = mergeProviderConfig(defaultProviderConfig(), parsed.data.providers);
    const groups = normalizeGroups(parsed.data.groups);
    const override = resolveModeOverride(modeOverride);
    const modeValue: QuotaMode = override ?? parsed.data.mode ?? "observe";
    const warnings = modeOverride && !override ? [`quota_mode_invalid:${modeOverride}`] : [];
    for (const provider of PROVIDER_IDS) {
      const providerConfig = providers[provider];
      if (providerConfig.scope === "group" && providerConfig.models && Object.keys(providerConfig.models).length) {
        warnings.push(`quota_models_ignored:${provider}`);
      }
    }
    return {
      config: { mode: modeValue, groups, providers },
      warnings,
      valid: true,
    };
  } catch (error) {
    return {
      config: { mode: resolveModeOverride(modeOverride) ?? "observe", groups: defaultGroups(), providers: defaultProviderConfig() },
      warnings: [`quota_config_invalid:${error instanceof Error ? error.message : "unknown"}`],
      valid: false,
    };
  }
}

/** Read `QUOTA_CONFIG_JSON`, with `QUOTA_MODE` as an operational override. */
export function loadQuotaConfig(): QuotaConfigResult {
  const text = process.env.QUOTA_CONFIG_JSON?.trim();
  const mode = process.env.QUOTA_MODE?.trim();
  if (!text) {
    const base = parseQuotaConfig({}, mode || undefined);
    return base;
  }
  try {
    return parseQuotaConfig(JSON.parse(text), mode || undefined);
  } catch {
    return {
      config: { mode: resolveModeOverride(mode) ?? "observe", groups: defaultGroups(), providers: defaultProviderConfig() },
      warnings: ["quota_config_invalid_json"],
      valid: false,
    };
  }
}
