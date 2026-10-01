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

      {/* Cobalt (live 2026-10-01) added validity transactions — a swap that stays
          dormant until your conditions hold. Surfaced here because it is a new
          capability no tab shows: it is an agent endpoint, not a connect-and-sign
          flow. */}
      <section className="card flex flex-col gap-2 border-base-blue/30 bg-base-blue/10 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-sky-200">
          <span>⏱️ Conditional swaps on Base</span>
          <span className="pill !px-2 !py-0.5 !text-[10px]">Cobalt</span>
        </div>
        <p className="text-xs leading-relaxed text-gray-300">
          A good-till-block or conditional order with no limit-order contract and nobody holding the trade. Base keeps
          your signed transaction dormant until every condition holds — a deadline block, a flashblock position, a
          balance floor, or a caller-supplied storage predicate for a price — then includes it. We never hold funds or
          keys: you sign and submit to Base&apos;s sequencer.
        </p>
      </section>

      <p className="text-xs text-gray-500">
        Agents: the same swap is <code className="codechip">GET /api/x402/near-swap</code> (cross-chain),{" "}
        <code className="codechip">GET /api/x402/base-swap</code> (on Base, ready-to-sign transaction), and{" "}
        <code className="codechip">GET /api/x402/base-swap-validity</code> (conditional — a Cobalt validity transaction).
      </p>
    </div>
  );
}
