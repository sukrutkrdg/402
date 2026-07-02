import { describe, it, expect, vi, beforeEach } from "vitest";

// Control DNS resolution so we can exercise the "hostname resolves to a private
// address" branch without real network.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { assertSafeWebhook } from "@/lib/alerts";

describe("assertSafeWebhook (SSRF guard)", () => {
  beforeEach(() => lookupMock.mockReset());

  it("rejects non-https URLs", async () => {
    await expect(assertSafeWebhook("http://example.com/hook")).rejects.toThrow();
  });

  it("rejects localhost", async () => {
    await expect(assertSafeWebhook("https://localhost/hook")).rejects.toThrow();
  });

  it("rejects the cloud-metadata IP literal", async () => {
    await expect(assertSafeWebhook("https://169.254.169.254/latest")).rejects.toThrow();
  });

  it("rejects private IPv4 literals", async () => {
    await expect(assertSafeWebhook("https://10.0.0.5/hook")).rejects.toThrow();
    await expect(assertSafeWebhook("https://192.168.1.1/hook")).rejects.toThrow();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(assertSafeWebhook("https://evil.example.com/hook")).rejects.toThrow();
  });

  it("accepts a hostname that resolves to a public address", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertSafeWebhook("https://good.example.com/hook");
    expect(url.hostname).toBe("good.example.com");
  });
});
