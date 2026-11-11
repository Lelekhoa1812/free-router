import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQuotaConfig, parseQuotaConfig } from "./config";

let configJson: string | undefined;
let mode: string | undefined;

beforeEach(() => {
  configJson = process.env.QUOTA_CONFIG_JSON;
  mode = process.env.QUOTA_MODE;
  delete process.env.QUOTA_CONFIG_JSON;
  delete process.env.QUOTA_MODE;
});

afterEach(() => {
  if (configJson === undefined) delete process.env.QUOTA_CONFIG_JSON;
  else process.env.QUOTA_CONFIG_JSON = configJson;
  if (mode === undefined) delete process.env.QUOTA_MODE;
  else process.env.QUOTA_MODE = mode;
});

describe("quota configuration", () => {
  it("defaults to observe and assigns every provider slot to one group", () => {
    const result = loadQuotaConfig();
    expect(result.valid).toBe(true);
    expect(result.config.mode).toBe("observe");
    expect(result.config.groups).toHaveLength(13);
    for (const group of result.config.groups) {
      expect(group.slots).toHaveLength(9);
      expect(group.slots[0]).toBe(1);
      expect(group.slots.at(-1)).toBe(9);
    }
    expect(result.config.providers.google.scope).toBe("model");
    expect(result.config.providers.openrouter.scope).toBe("group");
    expect(result.config.providers.openrouter.limits).toMatchObject({ rpm: 20, rpd: 50 });
    expect(result.config.providers.mistral).toMatchObject({ scope: "model", limits: { rpm: 5 } });
    expect(result.config.providers.tokenharbor).toMatchObject({ scope: "group", timeZone: "UTC", limits: { rpm: 20 } });
    expect(result.config.providers.groq).toMatchObject({ scope: "model", limits: { rpm: 30 }, models: { "groq/gpt-oss-20b": { rpd: 1_000, tpm: 8_000, tpd: 200_000 } } });
    expect(result.config.providers.novita).toMatchObject({ scope: "model", limits: {} });
    expect(result.config.providers.hyperbolic).toMatchObject({ scope: "group", limits: { rpm: 60 } });
    expect(result.config.providers.inference).toMatchObject({ scope: "group", limits: { rpm: 30 } });
    expect(result.config.providers.azure).toMatchObject({
      scope: "model",
      limits: {},
      models: {
        "azure/gpt-4.1-mini": { rpm: 200, tpm: 200_000 },
        "azure/gpt-5-mini": { rpm: 500, tpm: 500_000 },
        "azure/o4-mini": { rpm: 100, tpm: 100_000 },
        "azure/text-embedding-3-small": { tpm: 1_000_000 },
      },
    });
    expect(result.config.providers).not.toHaveProperty("nim");
    expect(result.config.groups.filter((group) => group.provider === "tokenharbor").flatMap((group) => group.slots)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("merges custom groups and limits, filling unassigned slots safely", () => {
    const result = parseQuotaConfig({
      groups: [{ id: "project-a", provider: "google", slots: [1, 2] }],
      providers: { google: { limits: { rpd: 20 } } },
    });
    expect(result.valid).toBe(true);
    const google = result.config.groups.filter((group) => group.provider === "google");
    expect(google.find((group) => group.id === "project-a")?.slots).toEqual([1, 2]);
    expect(google.find((group) => group.id === "default")?.slots).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(result.config.providers.google.limits).toMatchObject({ rpm: 5, rpd: 20 });
    expect(result.config.providers.openrouter.limits.rpd).toBe(50);
  });

  it("rejects duplicate slot assignments and falls back to defaults", () => {
    const result = parseQuotaConfig({
      groups: [
        { id: "a", provider: "google", slots: [1] },
        { id: "b", provider: "google", slots: [1] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatch(/quota_config_invalid/);
    expect(result.config.mode).toBe("observe");
    expect(result.config.groups.find((group) => group.provider === "google")?.id).toBe("default");
  });

  it("rejects unknown providers and invalid time zones", () => {
    expect(parseQuotaConfig({ providers: { bogus: {} } }).valid).toBe(false);
    expect(parseQuotaConfig({ providers: { google: { timeZone: "Mars/Olympus" } } }).valid).toBe(false);
  });

  it("lets QUOTA_MODE override the JSON mode", () => {
    process.env.QUOTA_MODE = "enforce";
    const result = loadQuotaConfig();
    expect(result.config.mode).toBe("enforce");
  });

  it("warns when per-model limits are configured under group scope", () => {
    const result = parseQuotaConfig({
      providers: { openrouter: { models: { "openrouter/nvidia/nemotron-3.5-super-vl:free": { rpd: 100 } } } },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("quota_models_ignored:openrouter");
    expect(parseQuotaConfig({ providers: { google: { models: { "google/gemini-3.6-flash": { rpd: 20 } } } } }).warnings)
      .not.toContain("quota_models_ignored:google");
  });

  it("keeps observation defaults when the JSON is malformed", () => {
    process.env.QUOTA_CONFIG_JSON = "{not-json";
    const result = loadQuotaConfig();
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("quota_config_invalid_json");
    expect(result.config.mode).toBe("observe");
  });

  it("keeps enforce selected when the JSON is malformed", () => {
    process.env.QUOTA_CONFIG_JSON = "{not-json";
    process.env.QUOTA_MODE = "enforce";
    const result = loadQuotaConfig();
    expect(result.valid).toBe(false);
    expect(result.config.mode).toBe("enforce");
  });

  it("keeps enforce selected when the config shape is invalid", () => {
    process.env.QUOTA_MODE = "enforce";
    const result = parseQuotaConfig({ providers: { google: { timeZone: "Mars/Olympus" } } }, "enforce");
    expect(result.valid).toBe(false);
    expect(result.config.mode).toBe("enforce");
  });
});
