/**
 * The first corporate action on a Coinbase tokenized equity, written down.
 *
 * Its own page rather than a paragraph on /stocks because it is the one thing
 * here that can be cited: a dated, block-numbered record of an event that has
 * happened exactly once, which anyone can re-run against an archive node and
 * either confirm or refute.
 *
 * Every figure below was read from chain at a stated block. Nothing is derived
 * from an announcement, and there was no announcement — the event was found by
 * a cron comparing yesterday's multipliers to today's.
 */

import Link from "next/link";

export const metadata = {
  title: "The first corporate action on a tokenized stock — 14 Sep 2026",
  description:
    "GOOGLc's multiplier moved 1.0 → 1.000377118676784179 in Base block 51310619. balanceOf did not move, and totalSupply did not move. Block-level evidence for why balanceOf is not the share count.",
};

// A fixed historical record. Nothing on this page changes.
export const revalidate = 86400;

const TX = "0xcd45e69e5b84d3f1808fe832d73c1ff7f332c7447bdf9c87925f196240ffeb00";
const GOOGLC = "0xb2000000000000000000002d0ba3164cc74f58b7";
const POOLMANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

function Row({ label, before, after, moved }: { label: string; before: string; after: string; moved: boolean }) {
  return (
    <tr>
      <td className="border-t border-base-line px-3 py-2 text-xs text-gray-400">{label}</td>
      <td className="border-t border-base-line px-3 py-2 font-mono text-xs">{before}</td>
      <td className="border-t border-base-line px-3 py-2 font-mono text-xs">{after}</td>
      <td
        className={`border-t border-base-line px-3 py-2 text-xs font-semibold ${
          moved ? "text-amber-300" : "text-gray-500"
        }`}
      >
        {moved ? "changed" : "unchanged"}
      </td>
    </tr>
  );
}

export default function FirstCorporateActionPage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <span className="pill w-fit">📐 On-chain record · 14 September 2026</span>
        <h1 className="text-3xl font-bold tracking-tight">
          The first corporate action on a Coinbase tokenized stock
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          At <strong className="text-gray-200">18:29:45 UTC</strong> on 14 September 2026, in Base
          block <strong className="text-gray-200">51310619</strong>, GOOGLc&apos;s{" "}
          <code className="codechip">multiplier()</code> moved for the first time. Across all
          thirteen of Coinbase&apos;s tokenized equities there had never been a split, a reverse
          split or a dividend adjustment until this one.
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Nothing announced it. It was found by comparing yesterday&apos;s multipliers to
          today&apos;s, which is the only reason this page can state the block.
        </p>
      </section>

      <section className="card flex flex-col gap-3 border-amber-500/30 bg-amber-500/5 p-5">
        <h2 className="text-lg font-semibold text-amber-200">What actually changed</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 font-medium">read</th>
                <th className="px-3 py-2 font-medium">block 51310618</th>
                <th className="px-3 py-2 font-medium">block 51310620</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              <Row
                label="multiplier()"
                before="1000000000000000000"
                after="1000377118676784179"
                moved
              />
              <Row label="totalSupply()" before="625695500195" after="625695500195" moved={false} />
              <Row
                label="balanceOf(Uniswap V4 PoolManager)"
                before="49170507575"
                after="49170507575"
                moved={false}
              />
            </tbody>
          </table>
        </div>
        <p className="text-xs leading-relaxed text-gray-300">
          The multiplier rose by <strong className="text-gray-200">0.0377%</strong>. Supply did not
          move, so nothing was minted. The largest holder&apos;s balance did not move either — and
          that holder is a contract, Uniswap V4&apos;s PoolManager, holding 491.70507575 GOOGLc by
          the number the chain reports.
        </p>
        <p className="text-xs leading-relaxed text-gray-300">
          Its entitlement is now about <strong className="text-gray-200">0.185 shares higher</strong>{" "}
          than the block before. Every contract, wallet and indexer reading{" "}
          <code className="codechip">balanceOf</code> shows the number from before.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Check it yourself</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Three archive reads against any Base RPC. If they disagree with the table above, this page
          is wrong and we would like to know.
        </p>
        <pre className="overflow-x-auto rounded-xl border border-base-line bg-black/50 p-4 text-[12px] leading-relaxed text-sky-200">
{`TOKEN=${GOOGLC}     # GOOGLc
HOLDER=${POOLMANAGER}    # Uniswap V4 PoolManager

# multiplier() either side of the event
cast call $TOKEN "multiplier()(uint256)" --block 51310618
cast call $TOKEN "multiplier()(uint256)" --block 51310620

# the holder's balance either side of the same event
cast call $TOKEN "balanceOf(address)(uint256)" $HOLDER --block 51310618
cast call $TOKEN "balanceOf(address)(uint256)" $HOLDER --block 51310620`}
        </pre>
        <p className="text-xs leading-relaxed text-gray-400">
          The transaction is{" "}
          <a
            className="font-mono text-sky-400 hover:underline"
            href={`https://basescan.org/tx/${TX}`}
            target="_blank"
            rel="noreferrer"
          >
            {TX.slice(0, 18)}…
          </a>
          , sent to the token contract and carrying three logs.
        </p>
      </section>

      <section className="card flex flex-col gap-3 p-5">
        <h2 className="text-lg font-semibold text-gray-200">Why 0.0377% is the interesting part</h2>
        <p className="text-xs leading-relaxed text-gray-400">
          A split is a round number. This is not one, and it is far too small to be one — it is the
          shape of an <strong className="text-gray-200">accrual</strong>: a small, irregular
          entitlement increase of the kind a dividend or a securities-lending return produces.
        </p>
        <p className="text-xs leading-relaxed text-gray-400">
          Base&apos;s own Request for Builders said tokenized stocks &ldquo;may have yield-generating
          mechanics&rdquo; and called the result productive assets. This is what that looks like on
          chain, and it means the next one is a matter of weeks rather than years. Anything built on
          these assets that caches a balance will be wrong again, on a schedule, without being told.
        </p>
        <p className="text-xs leading-relaxed text-gray-400">
          We are not classifying this as scheduled or emergency, because one sample is not a
          taxonomy. It is the first sample there has ever been.
        </p>
      </section>

      <section className="card flex flex-col gap-2 p-5">
        <h2 className="text-lg font-semibold text-gray-200">What this does not say</h2>
        <p className="text-xs leading-relaxed text-gray-400">
          It does not say anyone lost money — a multiplier is a unit change, not a price change, and
          positions are redenominated rather than revalued. It does not say Coinbase did anything
          wrong; the mechanism is documented B20 behaviour and it worked. It does not predict when
          the next one lands, or on which ticker.
        </p>
        <p className="text-xs leading-relaxed text-gray-400">
          It says one thing: on these tokens the balance and the entitlement are different numbers,
          that difference is no longer hypothetical, and anything reading the first while meaning the
          second is quietly wrong from block 51310619 onward.
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
        <Link className="btn-primary !py-2 text-sm" href="/stocks">
          The live board, all 13 →
        </Link>
        <Link className="btn-primary !py-2 text-sm" href="/app?service=stock-position">
          Read a wallet&apos;s entitlement →
        </Link>
        <a className="btn-primary !py-2 text-sm" href="/api/stocks">
          Board as JSON →
        </a>
      </section>

      <p className="text-xs leading-relaxed text-gray-500">
        Read-only on-chain data. No trading, no custody, no advice. Figures were read at the blocks
        named and are fixed; the live board re-reads every load.
      </p>
    </div>
  );
}
