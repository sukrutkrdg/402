/**
 * NEAR staking yields — what liquid staking on NEAR actually pays, measured,
 * not advertised. A liquid staking token's price in NEAR only rises as staking
 * rewards accrue, so its yield is that price now against its price N days ago
 * (read from an archival node), annualised. The same number for every
 * provider, from the chain, with no marketing APY in it.
 *
 * For each provider: the measured APY, the staked NEAR behind it, and — for
 * an agent that may need to leave in a hurry — the cost of exiting now by
 * selling the token for wNEAR through NEAR Intents, instead of waiting the
 * ~2–3 day unstaking delay.
 */

import "server-only";
import { viewCall, blockAt, blockNear, viewCallAt, intentsTokens, findNearToken, parseUnits } from "./near-rpc";
import { dryQuote } from "./near-swap-quote";

interface Provider {
  name: string;
  token: string;
  /** A view returning yocto-NEAR per 1e24 token units. */
  priceView: string;
  /** Total NEAR staked through it, in yocto: [view, field]. */
  tvl: [string, string];
}

const PROVIDERS: Provider[] = [
  { name: "LiNEAR", token: "linear-protocol.near", priceView: "ft_price", tvl: ["get_summary", "total_staked_near_amount"] },
  { name: "Meta Pool stNEAR", token: "meta-pool.near", priceView: "get_st_near_price", tvl: ["get_contract_state", "total_actually_staked"] },
];

const asNum = (yocto: bigint) => Number(yocto / 10n ** 18n) / 1e6; // NEAR, 6 places

export async function nearStakingYields(params: Record<string, string>) {
  const days = params.days ? Number(params.days) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("days is the measuring window: 1–30 (default 7)");
  const sizeUsd = params.size ? Number(params.size) : 1000;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || sizeUsd > 1_000_000) throw new Error("size is the exit size in USD, e.g. 1000 (default)");
  const checkedAt = new Date().toISOString();

  // Find the block `days` ago: measure the block rate over a recent stretch, then jump.
  const head = await blockAt("final");
  if (!head) throw new Error("NEAR archival RPC did not return the latest block — not charged, retry shortly");
  const probe = await blockNear(head.height - 100_000);
  if (!probe || probe.timeMs >= head.timeMs) throw new Error("NEAR archival RPC could not measure block time — not charged, retry shortly");
  const msPerBlock = (head.timeMs - probe.timeMs) / (head.height - probe.height);
  const past = await blockNear(Math.round(head.height - (days * 86_400_000) / msPerBlock));
  if (!past) throw new Error("NEAR archival RPC did not return the past block — not charged, retry shortly");
  const elapsedDays = (head.timeMs - past.timeMs) / 86_400_000;

  const tokens = await intentsTokens();
  const wnear = tokens?.find((t) => t.assetId === "nep141:wrap.near");
  const nearUsd = wnear?.price ?? null;

  const rows = await Promise.all(
    PROVIDERS.map(async (p) => {
      const [nowRaw, thenRaw, tvlObj] = await Promise.all([
        viewCall<string>(p.token, p.priceView),
        viewCallAt<string>(p.token, p.priceView, past.height),
        viewCall<Record<string, string>>(p.token, p.tvl[0]),
      ]);
      const now = typeof nowRaw === "string" && /^\d+$/.test(nowRaw) ? BigInt(nowRaw) : null;
      const then = typeof thenRaw === "string" && /^\d+$/.test(thenRaw) ? BigInt(thenRaw) : null;
      const tvlRaw = tvlObj?.[p.tvl[1]];
      const tvl = typeof tvlRaw === "string" && /^\d+$/.test(tvlRaw) ? BigInt(tvlRaw) : null;

      let apyPct: number | null = null;
      if (now && then && then > 0n) {
        const growth = Number((now * 1_000_000_000n) / then) / 1e9;
        apyPct = +((Math.pow(growth, 365 / elapsedDays) - 1) * 100).toFixed(2);
      }
      const priceNear = now ? asNum(now) : null; // yocto per 1 token → NEAR per token

      // Instant exit: sell `size` USD of the token for wNEAR now, vs what it redeems for.
      let instantExit: { discountPct: number; getNear: string } | { unavailable: string } | null = null;
      const tok = tokens ? findNearToken(tokens, p.token) : undefined;
      if (!tokens || !wnear) instantExit = { unavailable: "NEAR Intents unreachable" };
      else if (!tok) instantExit = { unavailable: "not routed by NEAR Intents — exit by unstaking (~2–3 days)" };
      else if (priceNear && nearUsd) {
        const amountTok = sizeUsd / (priceNear * nearUsd);
        const base = parseUnits(amountTok.toFixed(Math.min(tok.decimals, 8)), tok.decimals);
        if (base) {
          try {
            const q = await dryQuote(tok, wnear, base);
            const fair = amountTok * priceNear;
            const got = Number(q.amountOut);
            instantExit = { discountPct: +(((fair - got) / fair) * 100).toFixed(2), getNear: q.amountOut };
          } catch (e) {
            if (/not charged/.test((e as Error).message)) throw e;
            instantExit = { unavailable: (e as Error).message.replace(/^No quote: /, "no quote: ") };
          }
        }
      }

      return {
        provider: p.name,
        token: p.token,
        priceNear: priceNear !== null ? +priceNear.toFixed(6) : null,
        apyPct,
        stakedNear: tvl !== null ? Math.round(asNum(tvl)) : null,
        stakedUsd: tvl !== null && nearUsd ? Math.round(asNum(tvl) * nearUsd) : null,
        instantExit,
        unstakeDelay: "~2–3 days (4 epochs) to unstake at full value",
        ...(now === null ? { note: `${p.priceView}() did not answer` } : then === null ? { note: "no price at the past block — APY not measured" } : {}),
      };
    }),
  );
  rows.sort((a, b) => (b.apyPct ?? -1) - (a.apyPct ?? -1));
  const best = rows.find((r) => r.apyPct !== null);

  return {
    chain: "near" as const,
    checkedAt,
    window: { days: +elapsedDays.toFixed(2), fromBlock: past.height, toBlock: head.height },
    nearUsd,
    exitSizeUsd: sizeUsd,
    best: best ? { provider: best.provider, apyPct: best.apyPct } : null,
    providers: rows,
    method:
      "APY = (price now / price at the past block)^(365 / days) − 1, where price is the token's redemption value in NEAR read from the contract. Measured, so it includes validator performance and fees; a short window is noisier.",
    note: "Plain staking with a validator pays about the same before fees, but the position cannot be sold — only unstaked.",
  };
}
