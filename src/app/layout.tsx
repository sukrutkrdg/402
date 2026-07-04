import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getBaseAppId, getSiteUrl } from "@/lib/config";
import FarcasterReady from "@/components/FarcasterReady";
import ThemeToggle from "@/components/ThemeToggle";

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
  applicationName: "x402 Bazaar",
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    siteName: "x402 Bazaar",
    url: SITE_URL,
    title: "x402 Bazaar — Pay-per-call API marketplace on Base",
    description:
      "Pay-per-call APIs for AI agents on Base. Pay a tiny USDC micro-payment per call over x402 — no keys, no signup.",
  },
  twitter: {
    card: "summary_large_image",
    title: "x402 Bazaar — Pay-per-call APIs on Base",
    description: "Pay-per-call APIs for AI agents. USDC over x402, no keys. MCP-ready.",
  },
  other: {
    // Base App verification / discovery tag. Distinct from the x402 Builder Code.
    ...(baseAppId ? { "base:app_id": baseAppId } : {}),
    // Farcaster Mini App embed (with fc:frame for backward compatibility).
    "fc:miniapp": JSON.stringify(miniappEmbed),
    "fc:frame": JSON.stringify(frameEmbed),
  },
};

export const viewport = { themeColor: "#0052ff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Apply the saved theme before paint to avoid a flash of the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('light',!d);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <FarcasterReady />
        <header className="site-header sticky top-0 z-20 border-b backdrop-blur">
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
            <nav className="-mx-1 flex max-w-full items-center gap-1.5 overflow-x-auto px-1 text-sm">
              <Link href="/" className="shrink-0 rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white">
                Marketplace
              </Link>
              <Link
                href="/app"
                className="shrink-0 rounded-lg px-3 py-1.5 font-medium text-sky-300 hover:bg-white/5 hover:text-sky-200"
              >
                🛡️ Check a token
              </Link>
              <Link
                href="/dashboard"
                className="shrink-0 rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                Dashboard
              </Link>
              <Link
                href="/agents"
                className="shrink-0 rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                For agents
              </Link>
              <a
                href="https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes"
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-lg px-3 py-1.5 text-gray-300 hover:bg-white/5 hover:text-white"
              >
                Docs ↗
              </a>
              <a
                href="https://x.com/sukrutkrdg"
                target="_blank"
                rel="noreferrer"
                aria-label="x402 Bazaar on X"
                title="@sukrutkrdg on X"
                className="shrink-0 grid h-8 w-8 place-items-center rounded-lg text-gray-300 hover:bg-white/5 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.97 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
                </svg>
              </a>
              <ThemeToggle />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 py-10 text-center text-xs text-gray-500">
          <p>Built with x402 v2 + Base Builder Codes (ERC-8021). Payments settle in USDC on Base mainnet.</p>
          <p className="mt-2">
            Contact:{" "}
            <a className="text-sky-400 hover:underline" href="mailto:sukrutkrdg@gmail.com">
              sukrutkrdg@gmail.com
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="https://x.com/sukrutkrdg" target="_blank" rel="noreferrer">
              X @sukrutkrdg
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="https://t.me/Bazaar402_bot" target="_blank" rel="noreferrer">
              Telegram bot
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="https://t.me/x402scout" target="_blank" rel="noreferrer">
              Token radar
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="https://github.com/sukrutkrdg/x402-bazaar-mcp" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
