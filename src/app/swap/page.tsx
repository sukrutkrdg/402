import SwapClient from "./SwapClient";

export const metadata = {
  title: "Swap — x402 Bazaar",
  description:
    "Swap between NEAR, Base, Ethereum, Solana, Bitcoin and more through NEAR Intents. Send from your own wallet to a one-time deposit address; nothing to connect, nothing held by us.",
};

export default function SwapPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🔁 Swap</span>
        <h1 className="text-3xl font-bold tracking-tight">Swap across chains</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          NEAR, Base, Ethereum, Solana, Bitcoin and more, through NEAR Intents. Get a one-time deposit address, send from
          your own wallet, and the output arrives at your address — usually within a minute. Funds go straight to NEAR
          Intents, never through us; if the swap cannot complete, they are refunded to you. Buying a NEAR token runs our
          token-safety check first.
        </p>
      </section>
      <SwapClient />
      <p className="text-xs text-gray-500">
        Agents: the same swap is <code className="codechip">GET /api/x402/near-swap</code> (cross-chain) and{" "}
        <code className="codechip">GET /api/x402/base-swap</code> (on Base, ready-to-sign transaction).
      </p>
    </div>
  );
}
