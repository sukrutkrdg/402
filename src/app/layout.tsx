import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getBaseAppId, getSiteUrl } from "@/lib/config";
import FarcasterReady from "@/components/FarcasterReady";
import HeaderNav from "@/components/HeaderNav";

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
  title: "x402 Bazaar — Pay-per-call API marketplace on Base & NEAR",
  description:
    "A pay-per-call API marketplace for agents on Base and NEAR, powered by x402 and Base Builder Codes. Every payment is attributed onchain via ERC-8021; NEAR agents can pay from NEAR.",
  applicationName: "x402 Bazaar",
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    siteName: "x402 Bazaar",
    url: SITE_URL,
    title: "x402 Bazaar — Pay-per-call API marketplace on Base & NEAR",
    description:
      "Pay-per-call APIs for AI agents on Base and NEAR. Pay a tiny USDC micro-payment per call over x402, or buy credits from NEAR — no keys, no signup.",
  },
  twitter: {
    card: "summary_large_image",
    title: "x402 Bazaar — Pay-per-call APIs on Base & NEAR",
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
        <meta name="color-scheme" content="light dark" />
        {/* Google AdSense. Kept as a plain tag (not next/script) so it lands in the
            server-rendered HTML — the AdSense crawler reads the raw response when
            it verifies the site, and a client-injected tag can be missed. */}
        <script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6789973356871306"
          crossOrigin="anonymous"
        />
        {/* Apply the saved theme before paint to avoid a flash of the wrong theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('light',!d);}catch(e){}})();`,
          }}
        />
        {/* Universal JSON-LD Structured Schema for AI Agents & Search Crawlers */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": `${SITE_URL}/#website`,
                  "url": SITE_URL,
                  "name": "x402 Bazaar",
                  "description": "Autonomous AI Agent API & Data Marketplace on Base",
                  "publisher": {
                    "@type": "Organization",
                    "name": "x402 Bazaar",
                    "url": SITE_URL,
                  },
                },
                {
                  "@type": "WebAPI",
                  "@id": `${SITE_URL}/#webapi`,
                  "name": "x402 Bazaar API Suite",
                  "description": "Pay-per-call microservices for AI agents on Base and NEAR, paid with x402 (USDC), with ERC-8021 builder attribution.",
                  "documentation": `${SITE_URL}/agents`,
                  "provider": {
                    "@type": "Organization",
                    "name": "x402 Bazaar",
                  },
                },
                {
                  "@type": "SoftwareApplication",
                  "name": "x402-bazaar Developer CLI & Python SDK",
                  "operatingSystem": "All",
                  "applicationCategory": "DeveloperApplication",
                  "softwareVersion": "1.0.0",
                },
              ],
            }),
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <FarcasterReady />
        <header className="site-header sticky top-0 z-20 border-b backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5">
            {/* shrink-0 + nowrap: globals.css sets `* { min-width: 0 }`, so without
                these the logo is the flex item that gets squeezed in narrow mini-app
                webviews and "Base · NEAR" breaks one letter per line. The nav is the
                part that should give way — it scrolls horizontally instead. */}
            <Link href="/" className="flex shrink-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-base-blue to-[#0036aa] shadow-md shadow-base-blue/30">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-b from-white to-[#cfddff] text-[8px] font-black leading-none tracking-tighter text-[#0046e6] shadow-inner">
                  402
                </span>
              </span>
              <div className="whitespace-nowrap leading-tight">
                <div className="text-sm font-bold tracking-tight">x402 Bazaar</div>
                <div className="text-[10px] uppercase tracking-widest text-gray-500">
                  Base · NEAR
                </div>
              </div>
            </Link>
            <HeaderNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 py-10 text-center text-xs text-gray-500">
          <p>Built with x402 v2 + Base Builder Codes (ERC-8021). Payments settle in USDC on Base mainnet; NEAR agents can pay from NEAR via NEAR Intents.</p>
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
            <a className="text-sky-400 hover:underline" href="https://t.me/Bazaar402_bot">
              Telegram bot
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="https://t.me/x402scout">
              Token radar
            </a>{" "}
            ·{" "}
            <a className="text-sky-400 hover:underline" href="/status">
              Status
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
