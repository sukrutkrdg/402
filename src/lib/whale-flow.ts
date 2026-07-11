/**
 * whale-flow — "is anyone dumping this token right now?"
 *
 * Holder-forensics answers "who COULD dump" (snapshot). This answers "is size
 * moving toward the exits in the last 24h" (flow) — the answer decays in hours,
 * so a position-holding agent re-checks daily by necessity. Built on CDP SQL
 * (decoded Transfer events, the cdpTransfers pattern) + the cached DexScreener
 * pairs (to know which counterparties are DEX pools = sell/liquidity side).
 * No new upstreams.
 */

import "server-only";
import { getAddress } from "viem";
import { cdpSql } from "./covalent";
import { dexTokenPairs } from "./upstream-cache";

interface Pair {
  pairAddress?: string;
  baseToken?: { address?: string };
  liquidity?: { usd?: number };
}
interface Row {
  block_timestamp?: string;
  transaction_hash?: string;
  parameters?: { from?: string; to?: string; value?: string };
}

export async function whaleFlow(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… token contract address");
  const token = getAddress(raw);
  const t = token.toLowerCase();
  const hours = Math.min(72, Math.max(1, parseInt(params.hours || "24", 10) || 24));

  // DEX pool addresses = the "exit side". A big holder sending TO a pool is
  // adding liquidity / selling into it; receiving FROM one is a buy.
  const pairs = ((await dexTokenPairs<Pair>(token)) ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === t);
  const pools = new Set(pairs.map((p) => (p.pairAddress ?? "").toLowerCase()).filter(Boolean));

  // Largest transfers of this token in the window (CDP-indexed, decoded params).
  const rows = await cdpSql<Row>(
    `SELECT block_timestamp, transaction_hash, parameters FROM base.events WHERE address = '${t}' AND event_signature = 'Transfer(address,address,uint256)' AND block_timestamp > now() - INTERVAL ${hours} HOUR ORDER BY toUInt256OrZero(toString(parameters['value'])) DESC LIMIT 25`,
  );
  if (rows === null) throw new Error("Transfer history unavailable (data provider) — try again shortly");

  let toPools = 0n;
  let fromPools = 0n;
  const transfers = rows.map((r) => {
    const p = r.parameters ?? {};
    const from = (p.from ?? "").toLowerCase();
    const to = (p.to ?? "").toLowerCase();
    let v = 0n;
    try {
      v = BigInt(p.value ?? "0");
    } catch {
      v = 0n;
    }
    const dir = pools.has(to) ? "to_pool" : pools.has(from) ? "from_pool" : "wallet_to_wallet";
    if (dir === "to_pool") toPools += v;
    if (dir === "from_pool") fromPools += v;
    return { time: r.block_timestamp ?? null, from: p.from ?? null, to: p.to ?? null, valueRaw: (p.value ?? "0"), direction: dir, txHash: r.transaction_hash ?? null };
  });

  // Net token flow toward pools (sell pressure) vs away (accumulation), as a ratio.
  const net = toPools - fromPools;
  const totalPoolFlow = toPools + fromPools;
  const sellPressurePct = totalPoolFlow > 0n ? Number((net * 100n) / totalPoolFlow) : 0;
  const verdict =
    pools.size === 0
      ? "no_pool"
      : sellPressurePct >= 60
        ? "heavy_outflow"
        : sellPressurePct >= 20
          ? "net_selling"
          : sellPressurePct <= -20
            ? "net_buying"
            : "balanced";

  return {
    token,
    windowHours: hours,
    poolsTracked: pools.size,
    largeTransfers: transfers.length,
    netToPools: net.toString(),
    sellPressurePct,
    verdict, // heavy_outflow | net_selling | balanced | net_buying | no_pool
    topTransfers: transfers.slice(0, 12),
    recommendation:
      verdict === "heavy_outflow"
        ? "Size is moving into the pools right now — active sell pressure. If you're holding, re-check your exit (swap-route/exit-liquidity)."
        : verdict === "net_selling"
          ? "Net flow is toward the pools — mild sell pressure building."
          : verdict === "net_buying"
            ? "Net flow is out of the pools — accumulation over the window."
            : verdict === "no_pool"
              ? "No DEX pool found — can't classify flow direction."
              : "Flow is balanced over the window — no strong directional pressure.",
    note: `Largest token transfers in the last ${hours}h from CDP-indexed events, classified by DEX-pool counterparty. Raw token units (apply decimals for human amounts). Flow ≠ price. Not financial advice.`,
    checkedAt: new Date().toISOString(),
  };
}
