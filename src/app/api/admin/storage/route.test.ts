import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdminSession: vi.fn(), getDb: vi.fn(), getRedis: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ getAdminSession: mocks.getAdminSession }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/redis", () => ({ getRedis: mocks.getRedis }));

import { GET } from "./route";

describe("admin storage statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminSession.mockResolvedValue({ actor: "admin" });
    mocks.getRedis.mockReturnValue({ ping: vi.fn().mockResolvedValue("PONG"), dbsize: vi.fn().mockResolvedValue(12) });
  });

  it("counts only existing database collections and keeps database-wide totals", async () => {
    const listCollections = vi.fn().mockReturnValue({ toArray: async () => [{ name: "client_keys" }, { name: "requests" }, { name: "unmanaged" }] });
    const command = vi.fn(async (query: Record<string, unknown>) => {
      if (query.dbStats) return { dataSize: 1000, indexSize: 500 };
      if (query.collStats === "client_keys") return { count: 2, size: 200, totalIndexSize: 100 };
      if (query.collStats === "requests") return { count: 3, size: 800, totalIndexSize: 400 };
      if (query.collStats === "unmanaged") return { count: 1, size: 100, totalIndexSize: 0 };
      throw new Error("Unexpected collection");
    });
    mocks.getDb.mockResolvedValue({ databaseName: "freerouter", listCollections, command });

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.collections).toEqual([
      { name: "client_keys", count: 2, sizeBytes: 200, indexBytes: 100 },
      { name: "requests", count: 3, sizeBytes: 800, indexBytes: 400 },
      { name: "unmanaged", count: 1, sizeBytes: 100, indexBytes: 0 },
    ]);
    expect(body.collectionStatsComplete).toBe(true);
    expect(body.dataBytes + body.indexBytes).toBe(1500);
    expect(body.coordination.status).toBe("available");
    expect(body.coordination.keyCount).toBe(12);
    expect(body.coordination.pingMs).toEqual(expect.any(Number));
  });

  it("marks collection detail partial instead of inventing zero usage when a stats query fails", async () => {
    const listCollections = vi.fn().mockReturnValue({ toArray: async () => [{ name: "requests" }, { name: "responses" }] });
    const command = vi.fn(async (query: Record<string, unknown>) => {
      if (query.dbStats) return { dataSize: 1000, indexSize: 200 };
      if (query.collStats === "requests") return { count: 4, size: 700, totalIndexSize: 150 };
      throw new Error("stats unavailable");
    });
    mocks.getDb.mockResolvedValue({ databaseName: "freerouter", listCollections, command });

    const response = await GET();
    const body = await response.json();
    expect(body.collectionStatsComplete).toBe(false);
    expect(body.collections).toEqual([{ name: "requests", count: 4, sizeBytes: 700, indexBytes: 150 }]);
    expect(body.dataBytes).toBe(1000);
  });

  it("rejects requests without an admin session", async () => {
    mocks.getAdminSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("keeps MongoDB footprint available if the optional Redis sample fails", async () => {
    const listCollections = vi.fn().mockReturnValue({ toArray: async () => [] });
    const command = vi.fn(async () => ({ dataSize: 1000, indexSize: 200 }));
    mocks.getDb.mockResolvedValue({ databaseName: "freerouter", listCollections, command });
    mocks.getRedis.mockReturnValue({ ping: vi.fn().mockRejectedValue(new Error("Redis unavailable")), dbsize: vi.fn().mockResolvedValue(0) });

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.dataBytes).toBe(1000);
    expect(body.coordination).toMatchObject({ status: "unavailable", keyCount: null, pingMs: null });
  });
});
