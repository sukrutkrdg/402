import SwapTabs from "./SwapTabs";

export const metadata = {
  title: "Swap — x402 Bazaar",
  description:
    "Swap across NEAR, Base, Ethereum, Solana, Bitcoin and more through NEAR Intents, or on Base at the best DEX price with the route shown before you sign. Funds never pass through us.",
};

export default function SwapPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🔁 Swap</span>
        <h1 className="text-3xl font-bold tracking-tight">Swap — across chains or on Base</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Across chains — NEAR, Base, Ethereum, Solana, Bitcoin and more — through NEAR Intents: get a one-time deposit
          address, send from your own wallet, and the output arrives at your address, usually within a minute. On Base,
          connect a wallet and swap at the best price across Base DEXes, with the route shown before you sign. Funds never
          pass through us. Buying an unknown token runs our safety check first.
        </p>
      </section>
      <SwapTabs />
      <p className="text-xs text-gray-500">
        Agents: the same swap is <code className="codechip">GET /api/x402/near-swap</code> (cross-chain) and{" "}
        <code className="codechip">GET /api/x402/base-swap</code> (on Base, ready-to-sign transaction).
      </p>
    </div>
  );
}
