import { describe, expect, it, vi } from "vitest";
import { newAccessPassword, normalizeAdminEmail, uniqueAccessPassword, validAdminEmail } from "@/lib/auth/access";

describe("email-shared admin access primitives", () => {
  it("generates zero-padded six-digit passwords", () => {
    for (let i = 0; i < 500; i++) expect(newAccessPassword()).toMatch(/^\d{6}$/);
  });

  it("retries a random collision so rotation always changes the current code", () => {
    const draws = ["123456", "123456", "654321"];
    const generate = vi.fn(() => draws.shift()!);
    expect(uniqueAccessPassword("123456", generate)).toBe("654321");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(uniqueAccessPassword(null, () => "000007")).toBe("000007");
  });

  it("normalizes allowlist addresses before comparing or storing", () => {
    expect(normalizeAdminEmail("  Admin@Example.COM ")).toBe("admin@example.com");
    expect(validAdminEmail("admin@example.com")).toBe(true);
    expect(validAdminEmail("not-an-email")).toBe(false);
    expect(validAdminEmail("admin @example.com")).toBe(false);
  });
});
