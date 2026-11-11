import { describe, expect, it } from "vitest";
import { viewModels, type RegistryModel } from "./registry-view";

const models: RegistryModel[] = [
  { id: "groq/small", label: "Small", provider: "groq", context: 8_192, maxOutput: 1_024, text: "passed", tools: "unsupported", schema: "unsupported", vision: "unsupported", status: "ready" },
  { id: "google/long", label: "Long", provider: "google", context: 1_048_576, maxOutput: 65_536, text: "passed", tools: "passed", schema: "passed", vision: "passed", status: "experimental" },
  { id: "azure/mid", label: "Mid", provider: "azure", context: 128_000, maxOutput: null, text: "passed", tools: "passed", schema: "failed", vision: "unsupported", status: "unavailable" },
];

const base = { search: "", statuses: [], providers: [], tasks: [], contextBand: "any" as const, sortKey: "label" as const, sortDirection: "asc" as const };

describe("model registry view", () => {
  it("filters by provider, task, status, and context size together", () => {
    const rows = viewModels(models, { ...base, providers: ["google"], tasks: ["vision"], statuses: ["experimental"], contextBand: "million" });
    expect(rows.map((row) => row.id)).toEqual(["google/long"]);
  });

  it("sorts context size with unknown windows last", () => {
    const rows = viewModels(
      [...models, { ...models[0], id: "groq/unknown", label: "Unknown", context: null }],
      { ...base, sortKey: "context", sortDirection: "desc" },
    );
    expect(rows.at(-1)?.context).toBeNull();
    expect(rows[0]?.context).toBe(1_048_576);
  });
});
