/**
 * Oracle Staleness — can you trust this Uniswap-V3-style pool's TWAP oracle right
 * now, or will it revert / return a dangerously old window?
 *
 * A V3 pool exposes an onchain oracle: slot0() gives the ring-buffer cursor
 * (observationIndex) and size (observationCardinality); observations(index) gives
 * the newest stored observation's blockTimestamp. Two failure modes an agent must
 * screen before it reads a TWAP: (1) STALE — the newest observation is far behind
 * the chain head, so a TWAP covers the wrong window; (2) SHALLOW BUFFER — low
 * cardinality means observe() over a meaningful lookback reverts ("OLD") because
 * the buffer doesn't reach back that far.
 *
 * This is sharper after Denim (200ms blocks, docs.base.org/upgrades/denim): pools
 * can now write up to ~1 observation/second, so a fixed cardinality covers far
 * LESS wall-clock history than it did at 2s blocks. We anchor "now" to the
 * BaseTime predeploy (0x42…0030, timestampMs) when available, falling back to the
 * block timestamp.
 *
 * Pure Base RPC reads; degraded cleanly if the address isn't a V3-style pool or
 * the oracle can't be read. Not financial advice.
 */

import "server-only";
import { createPublicClient, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";

const client = createPublicClient({ chain: base, transport: baseTransport(8000, true) });

// BaseTime predeploy (Denim). timestampMs() → ms Unix time.
const BASETIME = "0x4200000000000000000000000000000000000030" as Address;
const BASETIME_ABI = [
  { type: "function", name: "timestampMs", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// Uniswap-V3 pool oracle read surface (Aerodrome Slipstream / PancakeSwap V3 share it).
const POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "observations",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      { name: "blockTimestamp", type: "uint32" },
      { name: "tickCumulative", type: "int56" },
      { name: "secondsPerLiquidityCumulativeX128", type: "uint160" },
      { name: "initialized", type: "bool" },
    ],
  },
] as const;

export async function oracleStaleness(params: Record<string, string>) {
  const raw = (params.pool || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Uniswap-V3-style pool address (pool=)");
  const pool = getAddress(raw);

  // 1) Read slot0 — also our "is this a V3-style pool?" probe.
  let slot0: readonly [bigint, number, number, number, number, number, boolean];
  try {
    slot0 = (await client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" })) as typeof slot0;
  } catch {
    return degraded(pool, "Not a Uniswap-V3-style pool, or slot0() unreadable — no onchain oracle to score.");
  }
  const observationIndex = slot0[2];
  const cardinality = slot0[3];
  const cardinalityNext = slot0[4];

  if (cardinality === 0) {
    return degraded(pool, "Pool reports zero oracle cardinality — no observations are being stored.");
  }

  // 2) Newest stored observation timestamp.
  let lastObsTs: number | null = null;
  try {
    const obs = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "observations",
      args: [BigInt(observationIndex)],
    })) as readonly [number, bigint, bigint, boolean];
    if (obs[3]) lastObsTs = Number(obs[0]); // initialized
  } catch {
    /* fall through — lastObsTs stays null */
  }

  // 3) "now": prefer BaseTime ms, fall back to the latest block timestamp.
  let nowSec: number;
  let nowSource: "basetime" | "block";
  try {
    const ms = (await client.readContract({ address: BASETIME, abi: BASETIME_ABI, functionName: "timestampMs" })) as bigint;
    nowSec = Number(ms / 1000n);
    nowSource = "basetime";
  } catch {
    const b = await client.getBlock();
    nowSec = Number(b.timestamp);
    nowSource = "block";
  }

  // NOTE: uint32 observation timestamps wrap every ~136y; the current epoch is far
  // from a boundary, so a raw diff is safe today.
  const ageSec = lastObsTs === null ? null : Math.max(0, nowSec - lastObsTs);

  // 4) Thresholds. Post-Denim, a pool can write ~1 obs/s, so a fixed cardinality
  //    covers much less wall-clock history — cardinality is the real constraint.
  const STALE_SEC = 1800; // 30m with no new observation ≈ stale for a TWAP
  const VERY_STALE_SEC = 7200; // 2h
  const SHALLOW_CARD = 60; // post-Denim, <~60 slots ≈ <1min of guaranteed history at full write rate

  const flags: string[] = [];
  if (ageSec !== null && ageSec >= VERY_STALE_SEC) flags.push(`newest observation is ${fmtAge(ageSec)} old — TWAP covers a stale window`);
  else if (ageSec !== null && ageSec >= STALE_SEC) flags.push(`newest observation is ${fmtAge(ageSec)} old`);
  if (ageSec === null) flags.push("could not read the newest observation timestamp");
  if (cardinality <= 1) flags.push("cardinality is 1 — only spot price is available; any multi-second observe() reverts (OLD)");
  else if (cardinality < SHALLOW_CARD) flags.push(`shallow oracle buffer (cardinality ${cardinality}) — at Denim's write rate this is a short lookback; longer observe() windows can revert`);
  if (cardinalityNext > cardinality) flags.push(`buffer is growing (next ${cardinalityNext}) — depth not yet realised`);

  let verdict: "healthy" | "shallow" | "stale" | "unusable";
  if (cardinality <= 1) verdict = "unusable";
  else if (ageSec !== null && ageSec >= VERY_STALE_SEC) verdict = "stale";
  else if (cardinality < SHALLOW_CARD || (ageSec !== null && ageSec >= STALE_SEC)) verdict = "shallow";
  else verdict = "healthy";

  return {
    pool,
    verdict, // healthy | shallow | stale | unusable
    observationCardinality: cardinality,
    observationCardinalityNext: cardinalityNext,
    observationIndex,
    lastObservationAgeSeconds: ageSec,
    lastObservationAt: lastObsTs === null ? null : new Date(lastObsTs * 1000).toISOString(),
    nowSource, // basetime (ms, Denim) | block
    flags,
    recommendation:
      verdict === "unusable"
        ? "🛑 Only spot price is stored (cardinality 1). Any TWAP read over more than the current block will revert — do NOT use this pool as a price oracle; increaseObservationCardinalityNext first or use a different source."
        : verdict === "stale"
          ? "⚠️ The newest observation is old — a TWAP here reflects a stale window and can be gamed by a single late write. Confirm the lookback you pass to observe() is actually covered before trusting it."
          : verdict === "shallow"
            ? "This oracle's buffer is shallow for Denim's 200ms blocks: a fixed cardinality now holds far less wall-clock history. Keep your TWAP window short, or expect observe() to revert (OLD) on longer lookbacks."
            : "Oracle looks current and the buffer has usable depth. Still size your observe() window to the realised cardinality, not the 'next' target.",
    note:
      "Reads a Uniswap-V3-style pool's oracle (slot0 cardinality + newest observation) and anchors 'now' to BaseTime (timestampMs) to score staleness / observe()-revert risk. Denim's 200ms blocks let pools write ~1 obs/s, so a fixed cardinality covers 10× less history than at 2s blocks — the buffer, not the clock, is usually the binding limit. A heuristic on the oracle surface, not the token. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

function fmtAge(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function degraded(pool: string, reason: string) {
  return {
    pool,
    verdict: "unknown" as const,
    degraded: true,
    observationCardinality: null,
    lastObservationAgeSeconds: null,
    flags: [] as string[],
    recommendation:
      "Could not score this pool's oracle — treat its TWAP as UNKNOWN, not safe, and confirm the pool type before relying on it.",
    note: `${reason} Not financial advice.`,
    checkedAt: new Date().toISOString(),
  };
}
