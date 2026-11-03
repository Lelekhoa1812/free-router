import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  smtpUser: "bootstrap@example.com",
  countDocuments: vi.fn(),
  insertOne: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/env", () => ({ env: { smtpUser: mocks.smtpUser } }));

import { seedBootstrapUser } from "./access";

describe("bootstrap admin enrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.smtpUser = "bootstrap@example.com";
    mocks.getDb.mockResolvedValue({ collection: () => ({ countDocuments: mocks.countDocuments, insertOne: mocks.insertOne }) });
    mocks.countDocuments.mockResolvedValue(0);
    mocks.insertOne.mockResolvedValue({ acknowledged: true });
  });

  it("only seeds the configured SMTP_USER address when the allowlist is empty", async () => {
    expect(await seedBootstrapUser("intruder@example.com")).toBe(false);
    expect(mocks.countDocuments).not.toHaveBeenCalled();
    expect(mocks.insertOne).not.toHaveBeenCalled();

    expect(await seedBootstrapUser("  BOOTSTRAP@example.com ")).toBe(true);
    expect(mocks.insertOne).toHaveBeenCalledWith(expect.objectContaining({ email: "bootstrap@example.com" }));
  });

  it("does not add the bootstrap address when another authorized user exists", async () => {
    mocks.countDocuments.mockResolvedValue(1);
    expect(await seedBootstrapUser("bootstrap@example.com")).toBe(false);
    expect(mocks.insertOne).not.toHaveBeenCalled();
  });
});
