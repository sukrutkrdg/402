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

      {/* The proof used to be a synthetic B20 whose multiplier we watched move
          1.0 → 2.0. It made the point but invited the obvious objection: that is
          a test token, not one of these. On 2026-09-14 the objection expired —
          GOOGLc took the first corporate action any of Coinbase's tokenized
          equities has ever had, and it behaved exactly as the synthetic one did.
          A claim about these tokens should be evidenced on these tokens. */}
      <section className="card flex flex-col gap-2 border-amber-500/30 bg-amber-500/5 p-4">
        <div className="text-sm font-semibold text-amber-200">
          Measured on the real thing — the first corporate action, 14 Sep 2026
        </div>
        <p className="text-xs leading-relaxed text-gray-300">
          <strong className="text-gray-200">GOOGLc</strong>&apos;s multiplier moved{" "}
          <strong className="text-gray-200">1.0 → 1.000377118676784179</strong> in block{" "}
          <strong className="text-gray-200">51310619</strong>. Read either side of it, Uniswap V4&apos;s
          PoolManager — the largest holder — returns{" "}
          <code className="codechip">balanceOf</code> ={" "}
          <strong className="text-gray-200">49170507575</strong> at block 51310618 and{" "}
          <strong className="text-gray-200">49170507575</strong> at block 51310620.{" "}
          <code className="codechip">totalSupply</code> is unchanged at{" "}
          <strong className="text-gray-200">625695500195</strong> too, so nothing was minted.
        </p>
        <p className="text-xs leading-relaxed text-gray-300">
          That position is entitled to about <strong className="text-gray-200">0.185</strong> more
          shares than it was the block before, and every contract, wallet and indexer reading{" "}
          <code className="codechip">balanceOf</code> still shows the old number. This is the event
          the page was built for, and it has now happened once — which is the whole argument for
          reading the entitlement rather than the balance.
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

      {/* Who may hold these, measured rather than assumed.
          Base's Request for Builders repeats three times that tokenized stocks
          are for "eligible users in permitted jurisdictions outside the United
          States", and every category it asks for — brokerage front-ends,
          personalised indices, gifting, yield stripping, agents allocating on
          their own — has to know whether an address can hold the asset before
          it builds a transaction. Nobody publishes that answer. It is two
          contract reads. */}
      <section className="card flex flex-col gap-3 border-amber-500/30 bg-amber-500/5 p-5">
        <h2 className="text-lg font-semibold text-amber-200">Who is allowed to hold these today</h2>
        <p className="text-xs leading-relaxed text-gray-300">{board.transferPolicy}</p>
        <p className="text-xs leading-relaxed text-gray-400">
          Read from the B20 policy registry at{" "}
          <code className="codechip">0x8453…0002</code>:{" "}
          <code className="codechip">policyId(TRANSFER_SENDER_POLICY)</code> on the token, then{" "}
          <code className="codechip">isAuthorized(policyId, address)</code> on the registry. The
          address we test with is a canary chosen for having no relationship to any of this — never
          KYC&apos;d, never a holder. Deliberately not one of our own wallets: a canary that could be
          individually allow-listed cannot detect a general tightening.
        </p>
        <p className="text-xs leading-relaxed text-gray-400">
          What this does <strong className="text-gray-200">not</strong> mean: that these tokens are
          unrestricted, or that they will stay this way. Eligibility is enforced where the shares are
          issued and redeemed, which is Coinbase&apos;s own app — not at transfer. And a live policy
          id is something an administrator can change at any block, with nothing about the token
          address, its ABI or its multiplier changing to announce it. We re-read all{" "}
          {board.count} every day and say so the moment an answer moves.
        </p>
      </section>

      <section className="card flex flex-col gap-2 p-5">
        <h2 className="text-lg font-semibold text-gray-200">What this page is not</h2>
        <p className="text-xs leading-relaxed text-gray-400">
          It is every tokenized equity <strong className="text-gray-200">Coinbase</strong> has
          issued on Base, and it is complete: as of 2026-09-10 there are 91 B20 tokens carrying 8
          decimals and only these {board.count} are equities — the rest are test tokens with random
          symbols. It is <strong className="text-gray-200">not</strong> every tokenized stock on
          Base. Other issuers are here too, and they are built differently: Bitwise&apos;s{" "}
          <code className="codechip">Mag7X</code> and xStocks&apos;{" "}
          <code className="codechip">AAPLx</code> are plain ERC-20 with 18 decimals and no{" "}
          <code className="codechip">multiplier()</code>.
        </p>
        <p className="text-xs leading-relaxed text-gray-400">
          That difference is why they are absent rather than pending. Both claims this page rests on
          are B20 claims: membership is decided by the transfer-policy administrator, which a plain
          ERC-20 does not have — we would be back to a hardcoded list, the thing the section above
          says we do not keep. And the balance gap does not exist for them at all: with no
          multiplier, <code className="codechip">balanceOf</code> really is the share count. Listing
          them here would mean asserting two things about them that are not true.
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

      {/* This used to read "the number of multiplier changes to date is zero",
          which was true for as long as it was true and became false the moment
          GOOGLc moved. A count belongs in the board above, which derives it; a
          footer that asserts one is a claim waiting to go stale. */}
      <p className="text-xs leading-relaxed text-gray-500">
        Read-only onchain data. No trading, no custody, no advice. Multipliers are re-read daily and
        the figures above are whatever the chain returned on this page load — the first corporate
        action across these {board.count} landed on 14 September 2026, and this page makes no claim
        about any history beyond what it can show you.
      </p>
    </div>
  );
}
