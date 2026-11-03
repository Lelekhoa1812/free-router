import { providers } from "@/lib/env";
import { MODEL_CATALOG } from "@/lib/models/catalog";
import { loadQuotaConfig, type QuotaLimit, type QuotaMode } from "./config";
import { getQuotaSnapshot, quotaTarget, type QuotaSnapshot } from "./ledger";

export interface QuotaDashboardRow {
  model: string;
  label: string;
  limits: QuotaLimit;
  snapshot: QuotaSnapshot;
}

export interface QuotaDashboardGroup {
  id: string;
  label: string;
  slots: number[];
  scope: "group" | "model";
  timeZone: string;
  rows: QuotaDashboardRow[];
}

export interface QuotaDashboardProvider {
  id: string;
  label: string;
  groups: QuotaDashboardGroup[];
}

export interface QuotaDashboard {
  available: boolean;
  mode: QuotaMode;
  generatedAt: string;
  warnings: string[];
  providers: QuotaDashboardProvider[];
}

/**
 * Read-only dashboard projection. Redis is the live counter source; no provider
 * secret or prompt content is included.
 */
export async function getQuotaDashboard(now: Date = new Date()): Promise<QuotaDashboard> {
  const loaded = loadQuotaConfig();
  const warnings = [...loaded.warnings];
  let available = true;

  const result = await Promise.all(
    providers.map(async (provider) => {
      const config = loaded.config.providers[provider.id];
      const groups = loaded.config.groups.filter((group) => group.provider === provider.id);
      const dashboardGroups = await Promise.all(
        groups.map(async (group) => {
          const models =
            config.scope === "group"
              ? [{ id: "*", label: "All free models" }]
              : MODEL_CATALOG.filter(
                  (model) => model.provider === provider.id && model.status === "ready" && model.text === "passed",
                ).map((model) => ({ id: model.id, label: model.label }));

          const rows = await Promise.all(
            models.map(async (model) => {
              const target = quotaTarget(loaded.config, provider.id, group, model.id);
              const snapshot = await getQuotaSnapshot(target, now);
              if (!snapshot.available) available = false;
              return { model: model.id, label: model.label, limits: target.limits, snapshot };
            }),
          );
          return {
            id: group.id,
            label: group.label ?? group.id,
            slots: [...group.slots],
            scope: config.scope,
            timeZone: config.timeZone,
            rows,
          } satisfies QuotaDashboardGroup;
        }),
      );
      return { id: provider.id, label: provider.label, groups: dashboardGroups } satisfies QuotaDashboardProvider;
    }),
  );

  if (loaded.config.groups.some((group) => group.provider === "google" && group.slots.length > 1)) {
    warnings.push("Google quotas are applied per project, not per API key. Confirm every slot in a Google group belongs to the same project.");
  }
  if (providers.some((provider) => provider.id === "openrouter")) {
    warnings.push("OpenRouter free-model daily requests are account-wide across all free models and reset at 00:00 UTC.");
  }
  warnings.push("NVIDIA does not publish per-model limits; the 40 RPM default is a conservative guard, not a provider contract.");
  warnings.push("Google and NVIDIA daily limits remain unconfigured until an operator enters them; requests still consume observed counters.");

  return {
    available,
    mode: loaded.config.mode,
    generatedAt: now.toISOString(),
    warnings: [...new Set(warnings)],
    providers: result,
  };
}
