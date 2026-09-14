import { describe, it, expect } from "vitest";
import { clientIp } from "@/lib/rate-limit";

/**
 * Who the caller is, when there are two proxies in front of us.
 *
 * 402.com.tr is proxied through Cloudflare into Vercel, so the connection
 * Vercel sees originates at a Cloudflare edge server. `x-vercel-forwarded-for`
 * reports that edge accurately — and it is not the caller. Edges and
 * connections vary, so requests from one machine arrived under a different
 * identity each time.
 *
 * Measured on 2026-09-14: four consecutive free-tier calls from one machine all
 * came back `x-free-tier: true, x-free-remaining: 0`, each counted as somebody's
 * first call of the day. Nothing was cached — `cf-cache-status: DYNAMIC` and
 * `x-vercel-cache: MISS` throughout — the counter was writing a fresh key every
 * time.
 *
 * Two guards were silently ineffective, not one: the free tier promises one call
 * per IP per day on every surface we publish and was giving them away without
 * limit, and the per-IP rate limit meant to blunt a DoS was bucketing by edge
 * connection. Both read this one function, which is why it is worth pinning.
 */

const req = (headers: Record<string, string>) => new Request("https://402.com.tr/api/x402/gas-oracle", { headers });

describe("clientIp behind Cloudflare", () => {
  it("prefers the Cloudflare header, because Vercel's reports the edge", () => {
    const ip = clientIp(
      req({
        "cf-connecting-ip": "203.0.113.7",
        "x-vercel-forwarded-for": "172.71.10.1", // a Cloudflare PoP
        "x-forwarded-for": "172.71.10.1",
      }),
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("gives one identity to repeated calls that cross different edges", () => {
    // The exact shape of the bug: same caller, different Cloudflare PoP each
    // time. Before the fix these were three separate free-tier quotas.
    const seen = ["172.71.10.1", "104.23.99.4", "172.68.2.20"].map((edge) =>
      clientIp(req({ "cf-connecting-ip": "203.0.113.7", "x-vercel-forwarded-for": edge })),
    );
    expect(new Set(seen).size).toBe(1);
  });

  it("still falls back to the Vercel header off Cloudflare", () => {
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
  });

  it("keeps the rest of the chain, in order", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.22" }))).toBe("198.51.100.22");
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.33, 10.0.0.1" }))).toBe("198.51.100.33");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("takes the first hop of a list and trims it", () => {
    expect(clientIp(req({ "cf-connecting-ip": "  203.0.113.7  " }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.9, 10.0.0.1" }))).toBe("198.51.100.9");
  });

  /**
   * Everything metered per caller resolves through here, so a regression is
   * never limited to the thing someone happens to be testing.
   */
  it("is the single source both the free tier and the rate limit read", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/x402/[service]/route.ts", "utf8");
    expect(route).toMatch(/const ip = clientIp\(req\)/);
    expect(route).toMatch(/consumeFree\(`free:\$\{ip\}:\$\{service\.id\}`\)/);
    expect(route, "no second way of deciding who the caller is").not.toMatch(
      /headers\.get\("x-forwarded-for"\)/,
    );
  });
});
