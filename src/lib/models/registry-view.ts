export interface RegistryModel {
  id: string;
  label: string;
  provider: string;
  context: number | null;
  maxOutput: number | null;
  text: string;
  tools: string;
  schema: string;
  vision: string;
  status: string;
}

export type ModelTask = "text" | "tools" | "schema" | "vision";
export type ContextBand = "any" | "unknown" | "compact" | "standard" | "long" | "million";
export type ModelSortKey = "label" | "provider" | "context" | "maxOutput" | "status";

export interface ModelRegistryQuery {
  search: string;
  statuses: string[];
  providers: string[];
  tasks: ModelTask[];
  contextBand: ContextBand;
  sortKey: ModelSortKey;
  sortDirection: "asc" | "desc";
}

const STATUS_RANK: Record<string, number> = { ready: 0, experimental: 1, restricted: 2, unavailable: 3 };

export function contextBand(context: number | null): Exclude<ContextBand, "any"> {
  if (context == null) return "unknown";
  if (context < 128_000) return "compact";
  if (context < 262_144) return "standard";
  if (context < 1_000_000) return "long";
  return "million";
}

export function formatTokenCount(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString()}k`;
  return value.toLocaleString();
}

export function viewModels(models: RegistryModel[], query: ModelRegistryQuery): RegistryModel[] {
  const search = query.search.trim().toLowerCase();
  const filtered = models.filter((model) => {
    if (search && !`${model.id} ${model.label} ${model.provider}`.toLowerCase().includes(search)) return false;
    if (query.statuses.length && !query.statuses.includes(model.status)) return false;
    if (query.providers.length && !query.providers.includes(model.provider)) return false;
    if (query.tasks.some((task) => model[task] !== "passed")) return false;
    if (query.contextBand !== "any" && contextBand(model.context) !== query.contextBand) return false;
    return true;
  });
  const direction = query.sortDirection === "asc" ? 1 : -1;
  return filtered.sort((left, right) => {
    const compared = compareModels(left, right, query.sortKey, direction);
    if (compared !== 0) return compared;
    return left.label.localeCompare(right.label);
  });
}

function compareModels(left: RegistryModel, right: RegistryModel, key: ModelSortKey, direction: 1 | -1): number {
  if (key === "context" || key === "maxOutput") {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    return (leftValue - rightValue) * direction;
  }
  if (key === "status") return ((STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9)) * direction;
  return left[key].localeCompare(right[key]) * direction;
}
