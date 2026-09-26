/**
 * The NEAR side of the marketplace: what NEAR agents can buy here, how they
 * pay from NEAR, and a live snapshot of the NEAR market as NEAR Intents sees it.
 *
 * The snapshot is read from NEAR Intents' public token list (prices and routed
 * assets) — the same source the NEAR services price with, so the page and the
 * API agree. If the list cannot be read, the page still renders without it.
 */

import Link from "next/link";
import { SERVICES } from "@/lib/services";
import { getSiteUrl } from "@/lib/config";
import { intentsTokens } from "@/lib/near-rpc";
import { nearCreditsOn } from "@/lib/near-funding";

export const metadata = {
  title: "NEAR — x402 Bazaar",
  description:
    "Safety and market checks for agents on NEAR: token control, transfer preflight, NEAR Intents swap quotes, pre-trade gate, account and portfolio. Pay from NEAR with USDC, USDT or NEAR.",
};

// Prices move; the list of routed assets does not. Five minutes is plenty.
export const revalidate = 300;

/** Bind-first order: the gate, then what it is built from, then account reads. */
const NEAR_ORDER = [
  "near-pre-trade-gate",
  "near-token-safety",
  "near-transfer-preflight",
  "near-swap-quote",
  "near-account",
  "near-portfolio",
];

const EXAMPLES: Record<string, string> = {
  "near-pre-trade-gate": "token=wrap.near",
  "near-token-safety": "token=usdt.tether-token.near",
  "near-transfer-preflight": "token=usdt.tether-token.near&to=tether.multisafe.near",
  "near-swap-quote": "from=USDC&to=NEAR&amount=100",
  "near-account": "account=tether.multisafe.near",
  "near-portfolio": "account=tether.multisafe.near",
};

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toPrecision(3)}`;
}

export default async function NearPage() {
  const site = getSiteUrl();
  const tokens = await intentsTokens();
  const services = NEAR_ORDER.map((id) => SERVICES.find((s) => s.id === id)).filter(
    (s): s is (typeof SERVICES)[number] => Boolean(s && !s.hidden),
  );

  const chains = tokens ? new Set(tokens.map((t) => t.blockchain)) : null;
  const near = tokens
    ? tokens
        .filter((t) => t.blockchain === "near" && t.contractAddress && typeof t.price === "number" && t.price > 0)
        .filter((t, i, all) => all.findIndex((x) => x.contractAddress === t.contractAddress) === i)
    : [];
  const wnear = near.find((t) => t.contractAddress === "wrap.near");
  const stables = near.filter((t) => /^(USDC|USDT|USDt|DAI|FRAX|USD1|nrUsdt)$/i.test(t.symbol));
  const others = near
    .filter((t) => !stables.includes(t) && t !== wnear)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">Ⓝ NEAR</span>
        <h1 className="text-3xl font-bold tracking-tight">Check a NEAR token before your agent takes it</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          On NEAR, whoever holds a <strong className="text-gray-200">full-access key</strong> on a token&apos;s account can
          replace its code — and an issuer that holds no key can still hold an{" "}
          <strong className="text-gray-200">owner role</strong> that pauses, blacklists or mints. These checks read
          that from the chain, test whether you can get back out through NEAR Intents, and answer GO / HOLD / STOP.
          Pay per call, or with a credit token bought from NEAR.
        </p>
      </section>

      {/* Live snapshot */}
      <section className="flex flex-col gap-3 rounded-2xl border border-teal-500/30 bg-teal-500/5 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">NEAR market, as NEAR Intents sees it</h2>
          <span className="text-[11px] text-gray-500">live · refreshed every 5 min</span>
        </div>
        {tokens ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <div className="label">wNEAR</div>
                <div className="mt-1 font-mono text-2xl font-bold">{wnear?.price ? fmtPrice(wnear.price) : "—"}</div>
              </div>
              <div>
                <div className="label">Assets routed</div>
                <div className="mt-1 font-mono text-2xl font-bold">{tokens.length}</div>
              </div>
              <div>
                <div className="label">Chains reached</div>
                <div className="mt-1 font-mono text-2xl font-bold">{chains?.size ?? 0}</div>
              </div>
              <div>
                <div className="label">NEAR tokens priced</div>
                <div className="mt-1 font-mono text-2xl font-bold">{near.length}</div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Token</th>
                    <th className="px-3 py-2">Contract</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Check</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(wnear ? [wnear] : []), ...stables, ...others].map((t) => (
                    <tr key={t.contractAddress}>
                      <td className="border-t border-base-line px-3 py-2 font-semibold">{t.symbol}</td>
                      <td className="border-t border-base-line px-3 py-2 font-mono text-[11px] text-gray-400">
                        {t.contractAddress!.length > 28 ? `${t.contractAddress!.slice(0, 12)}…${t.contractAddress!.slice(-8)}` : t.contractAddress}
                      </td>
                      <td className="border-t border-base-line px-3 py-2 text-right font-mono">{fmtPrice(t.price!)}</td>
                      <td className="border-t border-base-line px-3 py-2 text-right">
                        <a
                          className="text-xs text-sky-400 hover:underline"
                          href={`${site}/api/x402/near-pre-trade-gate?token=${encodeURIComponent(t.contractAddress!)}&free=1`}
                        >
                          gate →
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-500">
              Prices and routed assets from NEAR Intents&apos; public token list. &ldquo;gate&rdquo; runs the NEAR pre-trade
              gate on that token (one free call per day, then paid).
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400">The NEAR Intents token list is not reachable right now — try again shortly.</p>
        )}
      </section>

      {/* Services */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">NEAR checks</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {services.map((s) => (
            <div key={s.id} className="flex flex-col gap-2 rounded-2xl border border-base-line bg-black/30 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{s.name}</span>
                <span className="font-mono text-sm text-emerald-300">{s.price}</span>
              </div>
              <p className="text-sm text-gray-400">{s.tagline}</p>
              <code className="overflow-x-auto rounded-lg border border-base-line bg-black/50 px-2 py-1 text-[11px] text-sky-200">
                GET /api/x402/{s.id}?{EXAMPLES[s.id]}
              </code>
            </div>
          ))}
        </div>
      </section>

      {/* Paying */}
      <section className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <h2 className="text-lg font-semibold">Paying from NEAR</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-gray-400">
          {nearCreditsOn() && (
            <li>
              <strong className="text-gray-200">Credit token, bought from NEAR.</strong> Pay a pack with USDC, USDT or NEAR
              on NEAR through NEAR Intents at <Link className="text-sky-400 hover:underline" href="/credits">/credits</Link>{" "}
              (agents: <code className="codechip">POST /api/credits/near/quote</code>), then send it as the{" "}
              <code className="codechip">x-credit-token</code> header on any call.
            </li>
          )}
          <li>
            <strong className="text-gray-200">Chain Signatures.</strong> A NEAR account can control an EVM address and sign
            the standard x402 payment directly.
          </li>
          <li>
            <strong className="text-gray-200">Free first call.</strong> Add <code className="codechip">?free=1</code> for one
            call per service per day.
          </li>
        </ul>
        <p className="text-xs text-gray-500">
          Machine-readable: <a className="text-sky-400 hover:underline" href="/llms.txt">llms.txt</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/.well-known/x402">catalog</a> ·{" "}
          <a className="text-sky-400 hover:underline" href="/openapi.json">OpenAPI</a> · MCP at{" "}
          <code className="codechip">{site}/api/mcp</code>
        </p>
      </section>
    </div>
  );
}
