import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  credentialsFind: vi.fn(),
  slotLabelsFind: vi.fn(),
  healthFind: vi.fn(),
  credentialFindOne: vi.fn(),
  credentialUpdateOne: vi.fn(),
  slotLabelUpdateOne: vi.fn(),
  slotLabelDeleteOne: vi.fn(),
  auditInsertOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

import { getProviderCredentialSlots, probeProviderCredential, renameProviderSlot } from "@/lib/providers/credentials";

describe("Mistral credential probe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks the Mistral models endpoint with Bearer authentication", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeProviderCredential("mistral", "test-secret");

    expect(result).toEqual({ status: 200, ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.mistral.ai/v1/models");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
  });

  it("checks the TokenHarbor models endpoint with Bearer authentication", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeProviderCredential("tokenharbor", "test-secret");

    expect(result).toEqual({ status: 200, ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tokenharbor.ai/v1/models");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
  });
});

describe("provider credential slots, duplicates, and renaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.credentialsFind.mockResolvedValue([]);
    mocks.slotLabelsFind.mockResolvedValue([]);
    mocks.healthFind.mockResolvedValue([]);
    mocks.credentialFindOne.mockResolvedValue(null);
    mocks.credentialUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.slotLabelUpdateOne.mockResolvedValue({ acknowledged: true });
    mocks.slotLabelDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.auditInsertOne.mockResolvedValue({ acknowledged: true });
    mocks.getDb.mockResolvedValue({
      collection: (name: string) => {
        if (name === "provider_credentials") {
          return {
            find: () => ({ toArray: mocks.credentialsFind }),
            findOne: mocks.credentialFindOne,
            updateOne: mocks.credentialUpdateOne,
          };
        }
        if (name === "provider_slot_labels") {
          return {
            find: () => ({ toArray: mocks.slotLabelsFind }),
            updateOne: mocks.slotLabelUpdateOne,
            deleteOne: mocks.slotLabelDeleteOne,
          };
        }
        if (name === "credential_health") {
          return { find: () => ({ toArray: mocks.healthFind }) };
        }
        if (name === "audit_events") {
          return { insertOne: mocks.auditInsertOne };
        }
        return {};
      },
    });
  });

  it("reports duplicated key slots across the same or different providers and includes custom empty-slot labels", async () => {
    mocks.credentialsFind.mockResolvedValue([
      { provider: "nvidia", slot: 1, label: "Primary NIM", fingerprint: "dup-fp-1" },
      { provider: "nvidia", slot: 4, label: "Backup NIM", fingerprint: "dup-fp-1" },
      { provider: "nvidia", slot: 2, label: "Unique NIM", fingerprint: "uniq-fp-2" },
    ]);
    mocks.slotLabelsFind.mockResolvedValue([{ provider: "nvidia", slot: 7, label: "Reserved team slot" }]);
    mocks.healthFind.mockResolvedValue([
      { provider: "nvidia", fingerprint: "dup-fp-1", authStatus: "healthy" },
      { provider: "nvidia", fingerprint: "uniq-fp-2", authStatus: "healthy" },
    ]);

    const inventory = await getProviderCredentialSlots();
    const nvidia = inventory.find((p) => p.id === "nvidia")!;
    expect(nvidia.slots[0].duplicates).toEqual([
      { provider: "nvidia", providerLabel: "NVIDIA NIM", slot: 4, label: "Backup NIM" },
    ]);
    expect(nvidia.slots[3].duplicates).toEqual([
      { provider: "nvidia", providerLabel: "NVIDIA NIM", slot: 1, label: "Primary NIM" },
    ]);
    expect(nvidia.slots[1].duplicates).toEqual([]);
    expect(nvidia.slots[6].configured).toBe(false);
    expect(nvidia.slots[6].label).toBe("Reserved team slot");
  });

  it("persists renames for both configured credentials and empty slots", async () => {
    mocks.credentialFindOne.mockResolvedValueOnce({ _id: "1" });
    const configured = await renameProviderSlot("matilda", 2, "  Team Matilda Key  ");
    expect(configured).toEqual({ label: "Team Matilda Key", configured: true });
    expect(mocks.credentialUpdateOne).toHaveBeenCalledWith(
      { provider: "matilda", slot: 2 },
      { $set: expect.objectContaining({ label: "Team Matilda Key" }) },
    );

    mocks.credentialFindOne.mockResolvedValueOnce(null);
    const empty = await renameProviderSlot("matilda", 8, "  Staging Slot  ");
    expect(empty).toEqual({ label: "Staging Slot", configured: false });
    expect(mocks.slotLabelUpdateOne).toHaveBeenCalledWith(
      { provider: "matilda", slot: 8 },
      expect.objectContaining({ $set: expect.objectContaining({ label: "Staging Slot" }) }),
      { upsert: true },
    );
  });
});
