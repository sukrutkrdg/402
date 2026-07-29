import { CREDIT_TIERS } from "@/lib/credits";
import { SERVICES } from "@/lib/services";
import { Providers } from "../app/providers";
import CreditsClient from "./CreditsClient";

export const metadata = {
  title: "Prepaid API credits — x402 Bazaar",
  description:
    "Buy a prepaid balance once and your agent calls 100+ APIs with no wallet, no signature per call and no API key. Fund with a card through Coinbase if you hold no USDC.",
};

export const dynamic = "force-dynamic";

export default function CreditsPage() {
  const tiers = Object.entries(CREDIT_TIERS).map(([tier, v]) => ({ tier, ...v }));
  const visible = SERVICES.filter((s) => !s.hidden).length;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🎟️ Prepaid credits</span>
        <h1 className="text-3xl font-bold tracking-tight">Pay once. Your agent never signs again.</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          One purchase gives you a credit token. Send it as the{" "}
          <code className="text-sky-300">x-credit-token</code> header and all {visible} services work — no
          wallet, no signature per call, no API key, no subscription. Each call debits its own price from the
          balance.
        </p>
      </section>

      <Providers>
        <CreditsClient tiers={tiers} />
      </Providers>

      <section className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <h2 className="text-lg font-semibold">Why buy credit instead of paying per call</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-gray-400">
          <li>
            <strong className="text-gray-200">Your agent needs no wallet.</strong> Paying x402 per call means
            a funded key and a signature every time. A credit token is just a header — safe to hand to an MCP
            client, a CI job, or a teammate.
          </li>
          <li>
            <strong className="text-gray-200">No per-call settlement.</strong> Calls answer immediately
            instead of waiting on a facilitator round trip.
          </li>
          <li>
            <strong className="text-gray-200">Refusals aren&apos;t billed.</strong> If a check can&apos;t be
            answered because an upstream feed is down, the call is refunded automatically.
          </li>
          <li>
            <strong className="text-gray-200">Bigger packs carry a bonus</strong> and the balance is good for
            180 days. Re-buying tops up the same way.
          </li>
        </ul>
        <p className="text-xs text-gray-500">
          Prefer to script it? The same purchase works headlessly over x402:{" "}
          <code className="text-sky-300">/api/x402/buy-credits?tier=0.25|1|5|20</code>.
        </p>
      </section>
    </div>
  );
}
