import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getBaseAppId } from "@/lib/config";

const baseAppId = getBaseAppId();

export const metadata: Metadata = {
  title: "x402 Bazaar — Pay-per-call API marketplace on Base",
  description:
    "A pay-per-call API marketplace powered by x402 and Base Builder Codes. Every payment is attributed onchain via ERC-8021.",
  // Base App verification / discovery tag (base:app_id). Distinct from the
  // x402 Builder Code; set via NEXT_PUBLIC_BASE_APP_ID.
  other: baseAppId ? { "base:app_id": baseAppId } : {},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-base-line/70 bg-black/40 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-base-blue text-sm font-black text-white">
                ×4
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
