/**
<<<<<<< HEAD
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
import { knownLabel } from "./known-addresses";

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
=======
 * Whale Flow — who moved size in this token in the last 24h.
 *
 * Reads the token's decoded Transfer events from the CDP SQL API (short window,
 * so it stays far under the read limit), prices them via DexScreener, and
 * aggregates the flows agents actually act on: the largest transfers, the top
 * accumulating / distributing wallets, and mint/burn pressure.
 */

import "server-only";
import { createPublicClient, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { cdpSql } from "./covalent";
import { dexScreenerTokenPairs } from "./upstream-cache";

const ZERO = "0x0000000000000000000000000000000000000000";

interface DsPair {
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}
>>>>>>> 40b543d (Add upstream cache, watchlist, whale flow modules)

export async function whaleFlow(params: Record<string, string>) {
  const raw = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… token contract address");
  const token = getAddress(raw);
  const t = token.toLowerCase();
<<<<<<< HEAD
  const hours = Math.min(72, Math.max(1, parseInt(params.hours || "24", 10) || 24));

  // DEX pool addresses = the "exit side". A big holder sending TO a pool is
  // adding liquidity / selling into it; receiving FROM one is a buy.
  // null = DexScreener unavailable — that is NOT "no pool"; a paid answer must
  // never state "No DEX pool found" about a token nothing was read on.
  const rawPairs = await dexTokenPairs<Pair>(token);
  if (rawPairs === null) throw new Error("DEX pair data unavailable (provider) — try again shortly");
  const pairs = rawPairs.filter((p) => p.baseToken?.address?.toLowerCase() === t);
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
    return {
      time: r.block_timestamp ?? null,
      from: p.from ?? null,
      to: p.to ?? null,
      valueRaw: (p.value ?? "0"),
      direction: dir,
      txHash: r.transaction_hash ?? null,
      // Sourced registry labels for the counterparties — display only; direction is unchanged.
      fromLabel: knownLabel(from).label,
      toLabel: knownLabel(to).label,
    };
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
=======
  const hours = Math.min(48, Math.max(1, parseInt(params.hours || "24", 10) || 24));

  const rows = await cdpSql<{ block_timestamp?: string; transaction_hash?: string; parameters?: { from?: string; to?: string; value?: string } }>(
    `SELECT block_timestamp, transaction_hash, parameters FROM base.events WHERE address = '${t}' AND event_signature = 'Transfer(address,address,uint256)' AND block_timestamp > now() - INTERVAL ${hours} HOUR ORDER BY block_timestamp DESC LIMIT 300`,
  );
  if (rows === null) throw new Error("Transfer data unavailable: onchain index unreachable");

  // decimals + symbol from our own RPC (one multicall, no paid upstream).
  let decimals = 18;
  let symbol: string | null = null;
  try {
    const c = createPublicClient({ chain: base, transport: baseTransport(6000) });
    const erc20 = [
      { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
      { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    ] as const;
    const [d, s] = await c.multicall({
      contracts: [
        { address: token, abi: erc20, functionName: "decimals" },
        { address: token, abi: erc20, functionName: "symbol" },
      ],
      allowFailure: true,
    });
    if (d.status === "success") decimals = d.result as number;
    if (s.status === "success") symbol = s.result as string;
  } catch {
    /* keep defaults */
  }

  // Best-effort USD via DexScreener (cached); flows still rank by raw amount without it.
  let priceUsd: number | null = null;
  try {
    const ds = await dexScreenerTokenPairs<{ pairs?: DsPair[] | null }>(t);
    const pairs = (ds?.pairs ?? []).filter((p) => p.baseToken?.address?.toLowerCase() === t);
    if (pairs.length > 0) {
      const best = pairs.reduce((a, p) => ((p.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? p : a), pairs[0]);
      const n = parseFloat(best.priceUsd ?? "");
      if (Number.isFinite(n)) priceUsd = n;
    }
  } catch {
    /* USD stays null */
  }

  const transfers = rows
    .map((r) => {
      const p = r.parameters ?? {};
      let amount = 0;
      try {
        amount = p.value ? parseFloat(formatUnits(BigInt(p.value), decimals)) : 0;
      } catch {
        amount = 0;
      }
      return {
        from: (p.from ?? "").toLowerCase() || null,
        to: (p.to ?? "").toLowerCase() || null,
        amount,
        usd: priceUsd !== null ? +(amount * priceUsd).toFixed(2) : null,
        txHash: r.transaction_hash ?? null,
        time: r.block_timestamp ?? null,
      };
    })
    .filter((x) => x.amount > 0);

  // Net flow per wallet (mint/burn excluded from wallet ranking, counted separately).
  const net = new Map<string, number>();
  let minted = 0;
  let burned = 0;
  for (const x of transfers) {
    if (x.from === ZERO) minted += x.amount;
    else if (x.from) net.set(x.from, (net.get(x.from) ?? 0) - x.amount);
    if (x.to === ZERO) burned += x.amount;
    else if (x.to) net.set(x.to, (net.get(x.to) ?? 0) + x.amount);
  }
  const toUsd = (amt: number) => (priceUsd !== null ? +(amt * priceUsd).toFixed(2) : null);
  const ranked = [...net.entries()].map(([wallet, amount]) => ({ wallet, netAmount: +amount.toFixed(4), netUsd: toUsd(amount) }));
  const accumulators = ranked.filter((r) => r.netAmount > 0).sort((a, b) => b.netAmount - a.netAmount).slice(0, 5);
  const distributors = ranked.filter((r) => r.netAmount < 0).sort((a, b) => a.netAmount - b.netAmount).slice(0, 5);
  const largest = [...transfers].sort((a, b) => b.amount - a.amount).slice(0, 10);
  const totalMoved = transfers.reduce((s, x) => s + x.amount, 0);

  return {
    token,
    symbol,
    windowHours: hours,
    priceUsd,
    transferCount: transfers.length,
    sampled: rows.length >= 300, // true → only the most recent 300 transfers analysed
    totalMoved: +totalMoved.toFixed(4),
    totalMovedUsd: toUsd(totalMoved),
    minted: +minted.toFixed(4),
    burned: +burned.toFixed(4),
    largestTransfers: largest,
    topAccumulators: accumulators,
    topDistributors: distributors,
    note: "Decoded onchain Transfer flow for the window, ranked by size. Wallets include DEX pools and routers — a big 'distributor' can be a pool during a buy wave; cross-check addresses before acting. Not financial advice.",
>>>>>>> 40b543d (Add upstream cache, watchlist, whale flow modules)
    checkedAt: new Date().toISOString(),
  };
}
