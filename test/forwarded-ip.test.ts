import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientIp, forwardedIpHeaders } from "@/lib/rate-limit";

/**
 * The hosted MCP endpoint calls our own API from a Vercel egress IP, so every
 * hosted-MCP user shared one free quota. It now forwards the caller's IP in a
 * signed header; the signature is what keeps anyone else from choosing their IP.
 */
const req = (h: Record<string, string>) => new Request("https://402.com.tr/api/x402/x", { headers: h });

describe("signed forwarded client IP", () => {
  const prev = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
  });
  afterEach(() => {
    process.env.CRON_SECRET = prev;
  });

  it("uses the forwarded IP when the signature is ours", () => {
    expect(clientIp(req({ "cf-connecting-ip": "9.9.9.9", ...forwardedIpHeaders("1.2.3.4") }))).toBe("1.2.3.4");
  });

  it("ignores a forged or unsigned header", () => {
    expect(clientIp(req({ "cf-connecting-ip": "9.9.9.9", "x-402-client-ip": "1.2.3.4", "x-402-client-sig": "0".repeat(64) }))).toBe("9.9.9.9");
    expect(clientIp(req({ "cf-connecting-ip": "9.9.9.9", "x-402-client-ip": "1.2.3.4" }))).toBe("9.9.9.9");
  });

  it("a signature for one IP does not vouch for another", () => {
    const h = forwardedIpHeaders("1.2.3.4");
    expect(clientIp(req({ "cf-connecting-ip": "9.9.9.9", "x-402-client-ip": "5.6.7.8", "x-402-client-sig": h["x-402-client-sig"] }))).toBe("9.9.9.9");
  });

  it("forwards nothing without a secret", () => {
    process.env.CRON_SECRET = "";
    expect(forwardedIpHeaders("1.2.3.4")).toEqual({});
  });
});
