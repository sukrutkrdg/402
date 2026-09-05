/**
 * The board for Coinbase's tokenized equities on Base.
 *
 * One claim, made checkable: on a B20 Asset token `multiplier()` is not applied
 * to `balanceOf()`, so the number a wallet shows is not the number of shares
 * owned. That was measured, not inferred — token
 * 0xb2000000000000000000000971c4062c121ca876 had its multiplier moved 1.0 → 2.0
 * at block 50819308, and a holder's balanceOf read 100000000 at block 50819307
 * and 100000000 at block 50819309. The page cites the block so a reader can
 * check it rather than believe it.
 *
 * Free on purpose. A proof behind a paywall persuades nobody; the paid surface
 * is the per-wallet answer.
 */

import Link from "next/link";
import { readStockBoard } from "@/lib/tokenized-stocks";

export const metadata = {
  title: "Tokenized Stocks on Base — x402 Bazaar",
  description:
    "All 13 of Coinbase's tokenized equities on Base: live multiplier, supply and issuance status, and why balanceOf is not the share count.",
};

// The facts move on the order of weeks; a multiplier change is caught by a cron,
// not by whoever loads this page.
export const revalidate = 60;

function Cell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`border-t border-base-line px-3 py-2 align-middle ${className}`}>{children}</td>;
}

export default async function StocksPage() {
  const board = await readStockBoard();
  const issued = board.rows.filter((r) => r.issued === true);
  const pending = board.rows.filter((r) => r.issued === false);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">📊 Tokenized equities on Base</span>
        <h1 className="text-3xl font-bold tracking-tight">
          Your wallet is showing you the wrong number of shares
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Coinbase&apos;s tokenized stocks are <strong className="text-gray-200">B20 Asset</strong>{" "}
          tokens, and corporate actions — a split, a reverse split, a dividend adjustment — are
          settled by moving the token&apos;s <code className="codechip">multiplier</code>. The
          catch: <strong className="text-gray-200">B20 does not apply that multiplier to{" "}
          <code className="codechip">balanceOf</code></strong>. Your entitlement changes; the number
          every wallet, explorer and portfolio app displays does not.
        </p>
      </section>

      <section className="card flex flex-col gap-2 border-amber-500/30 bg-amber-500/5 p-4">
        <div className="text-sm font-semibold text-amber-200">Measured, not asserted — check it yourself</div>
        <p className="text-xs leading-relaxed text-gray-300">
          On B20 token <code className="codechip">0xb200…0971c4062c121ca876</code> the multiplier
          moved <strong className="text-gray-200">1.0 → 2.0</strong> at block{" "}
          <strong className="text-gray-200">50819308</strong>. A holder&apos;s{" "}
          <code className="codechip">balanceOf</code> read{" "}
          <strong className="text-gray-200">100000000</strong> at block 50819307 and{" "}
          <strong className="text-gray-200">100000000</strong> at block 50819309. The entitlement
          doubled. The balance did not move. <code className="codechip">totalSupply</code> behaves
          the same way.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold">
            All {board.count} on chain — {board.issuedCount} issued
          </h2>
          <span className="text-xs text-gray-500">
            live from Base · {new Date(board.asOf).toISOString().slice(0, 16).replace("T", " ")} UTC
            {board.degraded ? " · some reads unavailable, shown as —" : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 pb-2">Symbol</th>
                <th className="px-3 pb-2">Company</th>
                <th className="px-3 pb-2 text-right">Supply (shares)</th>
                <th className="px-3 pb-2 text-right">Multiplier</th>
                <th className="px-3 pb-2">Transfers</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((r) => (
                <tr key={r.token}>
                  <Cell className="font-mono font-semibold text-sky-200">{r.sym}</Cell>
                  <Cell className="text-gray-300">{r.name}</Cell>
                  <Cell className="text-right font-mono text-gray-200">
                    {r.supplyShares === null ? "—" : r.supplyShares.toLocaleString("en-US")}
                  </Cell>
                  <Cell className="text-right font-mono">
                    {r.multiplierRatio === null ? (
                      "—"
                    ) : r.multiplierRatio === 1 ? (
                      <span className="text-gray-400">1.0</span>
                    ) : (
                      <span className="font-semibold text-amber-300">{r.multiplierRatio}×</span>
                    )}
                  </Cell>
                  <Cell>
                    {r.transferPaused === null ? (
                      <span className="text-gray-500">—</span>
                    ) : r.transferPaused ? (
                      <span className="text-red-300">paused</span>
                    ) : (
                      <span className="text-emerald-300">live</span>
                    )}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pending.length > 0 && (
          <div className="card flex flex-col gap-1 p-4">
            <div className="text-sm font-semibold text-gray-200">
              Deployed, not yet issued — {pending.map((r) => r.sym).join(", ")}
            </div>
            <p className="text-xs leading-relaxed text-gray-400">
              All {board.count} contracts were created within five minutes of each other on
              2026-07-26; supply arrives in batches. These have a live contract and zero supply, so
              they are the next launches — visible here because this reads the chain rather than
              waiting for an announcement.
            </p>
          </div>
        )}

        <p className="text-xs leading-relaxed text-gray-400">{board.finding}</p>
      </section>

      <section className="card flex flex-col gap-3 border-base-blue/30 bg-base-blue/10 p-5">
        <h2 className="text-lg font-semibold text-sky-200">How we know which tokens these are</h2>
        <p className="text-xs leading-relaxed text-gray-300">
          Not from a list. A token qualifies by who administers its{" "}
          <code className="codechip">TRANSFER_SENDER_POLICY</code> on chain — the policy operator
          behind Coinbase&apos;s confirmed issuances. A lookalike can copy the ticker, the company
          name and even a <code className="codechip">0xb200…</code> vanity address; it cannot borrow
          the policy administrator. That is why the six equities issued on 2026-09-03 were already
          covered the day they went live, and why a fourteenth needs no code change from us.
        </p>
        <p className="text-xs leading-relaxed text-gray-300">
          The same read reports holder-eligibility gating and gated mint as the{" "}
          <strong className="text-gray-200">regulated shape they are</strong>, not as red flags — a
          risk model that scores a compliant issuer as dangerous is worse than none.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">For agents</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          This board is free. The per-wallet answer is a paid call — it returns both numbers for
          every holding, so an agent can see the gap rather than inherit it:
        </p>
        <pre className="overflow-auto rounded-xl border border-base-line bg-black/50 p-4 text-[12px] leading-relaxed text-sky-200">
{`curl "https://402.com.tr/api/x402/stock-position?wallet=0x…"
# 402 → pay $0.03 USDC over x402 → 200

{
  "held": 10,
  "positions": [
    { "symbol": "NVDAc",
      "rawBalance": "247479847018",   // what balanceOf returns
      "reportedShares": 2474.79847,    // what your wallet shows
      "multiplierRatio": 1,
      "entitledShares": 2474.79847,    // what you actually own
      "adjusted": false }
  ],
  "coverage": { "walletBalance": true, "uniswapV4Lp": false, "aaveCollateral": false }
}`}
        </pre>
        <p className="max-w-3xl text-xs leading-relaxed text-gray-400">
          The <code className="codechip">coverage</code> block is published on every response.
          Wallet-held balances are counted; pool, vault and lending exposure is not, and is declared
          rather than silently returned as zero — an omission that looks like a zero is how a
          position API causes the loss it exists to prevent.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link className="btn-primary !py-2 text-sm" href="/app?service=stock-position">
            Try stock-position →
          </Link>
          <Link className="btn-primary !py-2 text-sm" href="/agents">
            All agent endpoints →
          </Link>
          <a className="btn-primary !py-2 text-sm" href="/api/stocks">
            This board as JSON →
          </a>
        </div>
      </section>

      <p className="text-xs leading-relaxed text-gray-500">
        Read-only onchain data. No trading, no custody, no advice. Multiplier changes are watched
        daily; across all {board.count} the number of multiplier changes to date is zero, so nothing
        here claims a corporate-action history that does not yet exist.
      </p>
    </div>
  );
}
