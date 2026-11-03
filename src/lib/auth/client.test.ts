import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), hashClientKey: vi.fn((value: string) => `hash:${value}`) }));

vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/crypto", () => ({ hashClientKey: mocks.hashClientKey }));

import { authenticateClient } from "./client";

function request() {
  return new Request("https://freerouter.test/v1/chat/completions", {
    headers: { authorization: "Bearer sk-fr-test" },
  });
}

function database(record: Record<string, unknown>) {
  const updateOne = vi.fn().mockResolvedValue({});
  const findOne = vi.fn().mockResolvedValue(record);
  return { updateOne, db: { collection: vi.fn(() => ({ findOne, updateOne })) } };
}

function record(models: string[] | undefined) {
  return {
    _id: new ObjectId(),
    name: "test",
    scopes: ["chat"],
    ...(models === undefined ? {} : { models }),
    status: "active" as const,
    tokenHash: "hash:sk-fr-test",
  };
}

describe("client key model authority", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies every model when the allowlist is explicitly empty", async () => {
    const { db } = database(record([]));
    mocks.getDb.mockResolvedValue(db);

    await expect(authenticateClient(request(), "chat", "google/gemini-3.6-flash")).resolves.toEqual({ error: "model_forbidden" });
  });

  it("allows any model for the explicit wildcard", async () => {
    const { db } = database(record(["*"]));
    mocks.getDb.mockResolvedValue(db);

    await expect(authenticateClient(request(), "chat", "google/gemini-3.6-flash")).resolves.toHaveProperty("key");
  });

  it("allows a listed model and rejects an unlisted one", async () => {
    const { db } = database(record(["google/gemini-3.6-flash"]));
    mocks.getDb.mockResolvedValue(db);

    await expect(authenticateClient(request(), "chat", "google/gemini-3.6-flash")).resolves.toHaveProperty("key");
    await expect(authenticateClient(request(), "chat", "nvidia/z-ai/glm-5.3-flash")).resolves.toEqual({ error: "model_forbidden" });
  });

  it("keeps legacy records without a models field unrestricted", async () => {
    const { db } = database(record(undefined));
    mocks.getDb.mockResolvedValue(db);

    await expect(authenticateClient(request(), "chat", "google/gemini-3.6-flash")).resolves.toHaveProperty("key");
  });
});
