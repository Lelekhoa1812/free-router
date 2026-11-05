import { afterEach, describe, expect, it, vi } from "vitest";
import { probeProviderCredential } from "@/lib/providers/credentials";

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
});
