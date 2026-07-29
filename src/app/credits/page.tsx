import { CREDIT_TIERS } from "@/lib/credits";
import { stripeConfig } from "@/lib/stripe";
import { SERVICES } from "@/lib/services";
import CreditsClient from "./CreditsClient";

export const metadata = {
  title: "Buy API credits with a card — x402 Bazaar",
  description:
    "Prepaid balance for 100+ pay-per-call APIs on Base. Pay by card, get a token, use every service with no wallet and no API key.",
};

export const dynamic = "force-dynamic";

export default function CreditsPage() {
  const enabled = stripeConfig() !== null;
  const tiers = Object.entries(CREDIT_TIERS).map(([tier, v]) => ({ tier, ...v }));
  const visible = SERVICES.filter((s) => !s.hidden).length;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">💳 Prepaid credits</span>
        <h1 className="text-3xl font-bold tracking-tight">Your agent doesn&apos;t need a wallet</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          Pay once by card and get a credit token. Send it as the{" "}
          <code className="text-sky-300">x-credit-token</code> header and all {visible} services work — no
          wallet, no signature per call, no API key, no subscription. Already onchain? Buy the same credit
          with USDC over x402 at <code className="text-sky-300">/api/x402/buy-credits</code>.
        </p>
      </section>

      <CreditsClient tiers={tiers} enabled={enabled} />

      <section className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <h2 className="text-lg font-semibold">How it works</h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-gray-400">
          <li>Pick a pack and pay by card. Nothing is stored on your side.</li>
          <li>
            You get a one-time <code className="text-sky-300">ck_…</code> token. It&apos;s a bearer key —
            save it, it can&apos;t be shown again.
          </li>
          <li>
            Every call debits its price from the balance and returns what&apos;s left in the{" "}
            <code className="text-sky-300">x-credit-balance</code> header.
          </li>
          <li>
            If a check can&apos;t be answered because an upstream feed is down, the call is refunded
            automatically — you aren&apos;t billed for a refusal.
          </li>
        </ol>
      </section>
    </div>
  );
}
