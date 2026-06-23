import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getBaseAppId, getSiteUrl } from "@/lib/config";
import FarcasterReady from "@/components/FarcasterReady";

const baseAppId = getBaseAppId();
const SITE_URL = getSiteUrl();

// Farcaster Mini App embed — renders the URL as a launchable card in feeds.
const miniappEmbed = {
  version: "1",
  imageUrl: `${SITE_URL}/brand/embed`,
  button: {
    title: "Open x402 Bazaar",
    action: {
      type: "launch_miniapp",
      url: SITE_URL,
      name: "x402 Bazaar",
      splashImageUrl: `${SITE_URL}/brand/splash`,
      splashBackgroundColor: "#07080a",
    },
  },
};
const frameEmbed = {
  ...miniappEmbed,
  button: { ...miniappEmbed.button, action: { ...miniappEmbed.button.action, type: "launch_frame" } },
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "x402 Bazaar — Pay-per-call API marketplace on Base",
  description:
    "A pay-per-call API marketplace powered by x402 and Base Builder Codes. Every payment is attributed onchain via ERC-8021.",
  other: {
    // Base App verification / discovery tag. Distinct from the x402 Builder Code.
    ...(baseAppId ? { "base:app_id": baseAppId } : {}),
    // Farcaster Mini App embed (with fc:frame for backward compatibility).
    "fc:miniapp": JSON.stringify(miniappEmbed),
    "fc:frame": JSON.stringify(frameEmbed),
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <FarcasterReady />
        <header className="sticky top-0 z-20 border-b border-base-line/70 bg-black/40 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-base-blue to-[#0036aa] shadow-md shadow-base-blue/30">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-b from-white to-[#cfddff] text-[8px] font-black leading-none tracking-tighter text-[#0046e6] shadow-inner">
                  402
                </span>
              </span>
              <div className="leading-tight">
                <div className="text-sm font-bold tracking-tight">x402 Bazaar</div>
                <div className="text-[10px] uppercase tracking-widest text-gray-500">
                  Builder Codes · Base
                </div>
              </div>
            </Link>
            <nav className="flex items-center gap-1.5 text-sm">
              <Link href="/" className="rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white">
                Marketplace
              </Link>
              <Link
                href="/dashboard"
                className="rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                Attribution
              </Link>
              <Link
                href="/agents"
                className="rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                For agents
              </Link>
              <a
                href="https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes"
                target="_blank"
                rel="noreferrer"
                className="rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                Docs ↗
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 py-10 text-center text-xs text-gray-600">
          Built with x402 v2 + Base Builder Codes (ERC-8021). Payments settle in USDC on Base mainnet.
        </footer>
      </body>
    </html>
  );
}
