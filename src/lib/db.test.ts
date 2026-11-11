import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  createIndex: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { mongoUri: "mongodb://localhost:27017", mongoDb: "freerouter" } }));
vi.mock("mongodb", () => ({
  MongoClient: class {
    connect = mocks.connect;
  },
}));

import { getDb } from "./db";

describe("MongoDB connection caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis._freeRouterMongo = undefined;
    globalThis._freeRouterIndexes = undefined;
  });

  it("clears the cached connection and index promises on failure so subsequent calls recover", async () => {
    const fakeDb = { collection: () => ({ createIndex: mocks.createIndex }) };
    mocks.connect
      .mockRejectedValueOnce(new Error("transient timeout"))
      .mockResolvedValue({ db: () => fakeDb });
    mocks.createIndex
      .mockRejectedValueOnce(new Error("transient index timeout"))
      .mockResolvedValue("ok");

    await expect(getDb()).rejects.toThrow("transient timeout");
    expect(globalThis._freeRouterMongo).toBeUndefined();

    await expect(getDb()).rejects.toThrow("transient index timeout");
    expect(globalThis._freeRouterIndexes).toBeUndefined();

    const recovered = await getDb();
    expect(recovered).toBe(fakeDb);
  });
});
