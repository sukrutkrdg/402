/**
 * Farcaster Mini App manifest, served at /.well-known/farcaster.json
 * (via a rewrite in next.config.mjs).
 *
 * `accountAssociation` proves you own this domain with your Farcaster account.
 * Generate it once with the Farcaster Manifest tool, then set these env vars:
 *   FARCASTER_HEADER, FARCASTER_PAYLOAD, FARCASTER_SIGNATURE
 */

import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  const SITE_URL = getSiteUrl();
  return Response.json({
    accountAssociation: {
      // Public, domain-bound proof of ownership (signed for 402.com.tr, FID
      // 287286). Env vars override if you deploy to a different domain.
      header:
        process.env.FARCASTER_HEADER ||
        "eyJmaWQiOjI4NzI4NiwidHlwZSI6ImN1c3RvZHkiLCJrZXkiOiIweDg0ODhiNkY5NThiMTVlQzQxZjZiNmMyRWY4MkFEQzEwNTc4NTU5NjkifQ",
      payload: process.env.FARCASTER_PAYLOAD || "eyJkb21haW4iOiI0MDIuY29tLnRyIn0",
      signature:
        process.env.FARCASTER_SIGNATURE ||
        "9QthhsDzRfIRFps7v/hz4NbaCRs618p0F0FTAFlgRJcTGYfcFX1qjejoS+ZcR7EuZI6iKGzQdkpuqV+7n3AtjRs=",
    },
    miniapp: {
      version: "1",
      name: "x402 Bazaar",
      subtitle: "Pay-per-call APIs on Base",
      description:
        "A pay-per-call API marketplace on Base. Pay tiny USDC micro-payments over x402 and get results instantly — every payment attributed onchain with Builder Codes.",
      iconUrl: `${SITE_URL}/brand/icon`,
      homeUrl: SITE_URL,
      splashImageUrl: `${SITE_URL}/brand/splash`,
      splashBackgroundColor: "#07080a",
      heroImageUrl: `${SITE_URL}/brand/thumbnail`,
      ogImageUrl: `${SITE_URL}/opengraph-image`,
      screenshotUrls: [
        `${SITE_URL}/brand/shot1`,
        `${SITE_URL}/brand/shot2`,
        `${SITE_URL}/brand/shot3`,
      ],
      primaryCategory: "developer-tools",
      tags: ["x402", "payments", "base", "usdc", "api"],
    },
  });
}
