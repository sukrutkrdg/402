/**
 * Farcaster Mini App manifest, served at /.well-known/farcaster.json
 * (via a rewrite in next.config.mjs).
 *
 * `accountAssociation` proves you own this domain with your Farcaster account.
 * Generate it once with the Farcaster Manifest tool, then set these env vars:
 *   FARCASTER_HEADER, FARCASTER_PAYLOAD, FARCASTER_SIGNATURE
 */

export const dynamic = "force-dynamic";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://402-eight.vercel.app").replace(
  /\/$/,
  "",
);

export function GET() {
  return Response.json({
    accountAssociation: {
      header: process.env.FARCASTER_HEADER || "",
      payload: process.env.FARCASTER_PAYLOAD || "",
      signature: process.env.FARCASTER_SIGNATURE || "",
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
