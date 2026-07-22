/**
 * Morpho Vault Risk — the depositor-side read for a MetaMorpho vault on Base.
 *
 * MetaMorpho vaults are curated ERC-4626 vaults that spread deposits across
 * Morpho Blue markets. A depositor's risk isn't the vault wrapper — it's WHERE
 * the curator allocated the money (which markets, how concentrated, at what
 * liquidation LTVs) and WHO can move it (curator / owner / guardian, the fee,
 * the timelock). This reads all of that in one call. The depositor-side
 * complement to morpho-health (which reads a borrower position); no other Base
 * tool surfaces a vault's allocation + control risk for an agent. Not financial
 * advice.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { MORPHO_BLUE } from "./morpho";
import { finish } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const MAX_MARKETS = 12;

const vaultAbi = [
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "curator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "guardian", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint96" }] },
  { type: "function", name: "timelock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawQueueLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawQueue", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] },
] as const;
const morphoAbi = [
  { type: "function", name: "position", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }] },
  { type: "function", name: "market", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }] },
  { type: "function", name: "idToMarketParams", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] },
] as const;
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function fmt(v: bigint, decimals: number): string {
  const b = 10n ** BigInt(decimals);
  const whole = v / b;
  const frac = (v % b).toString().padStart(decimals, "0").slice(0, 2).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export async function metamorphoVault(params: Record<string, string>) {
  const addr = (params.vault || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("Provide a valid 0x... MetaMorpho vault address (vault=)");
  const v = getAddress(addr);

  // Round 1: vault metadata + queue length.
  const meta = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: v, abi: vaultAbi, functionName: "totalAssets" },
      { address: v, abi: vaultAbi, functionName: "name" },
      { address: v, abi: vaultAbi, functionName: "asset" },
      { address: v, abi: vaultAbi, functionName: "curator" },
      { address: v, abi: vaultAbi, functionName: "owner" },
      { address: v, abi: vaultAbi, functionName: "guardian" },
      { address: v, abi: vaultAbi, functionName: "fee" },
      { address: v, abi: vaultAbi, functionName: "timelock" },
      { address: v, abi: vaultAbi, functionName: "withdrawQueueLength" },
    ],
  });
  const totalAssets = meta[0].result as bigint | undefined;
  const asset = meta[2].result as string | undefined;
  if (totalAssets === undefined || asset === undefined) {
    throw new Error(`${v} isn't a readable MetaMorpho vault on Base (no totalAssets/asset). Check the address.`);
  }
  const name = typeof meta[1].result === "string" ? meta[1].result : "vault";
  const curator = (meta[3].result as string | undefined) ?? null;
  const owner = (meta[4].result as string | undefined) ?? null;
  const guardian = (meta[5].result as string | undefined) ?? null;
  const feeRaw = (meta[6].result as bigint | undefined) ?? 0n;
  const timelock = (meta[7].result as bigint | undefined) ?? 0n;
  const wql = Number((meta[8].result as bigint | undefined) ?? 0n);

  // Asset metadata + the market ids in the withdraw queue.
  const n = Math.min(wql, MAX_MARKETS);
  const queueCalls = Array.from({ length: n }, (_, i) => ({ address: v, abi: vaultAbi, functionName: "withdrawQueue" as const, args: [BigInt(i)] as const }));
  const [assetMeta, queue] = await Promise.all([
    client.multicall({ allowFailure: true, contracts: [
      { address: asset as `0x${string}`, abi: erc20Abi, functionName: "decimals" },
      { address: asset as `0x${string}`, abi: erc20Abi, functionName: "symbol" },
    ] }),
    n ? client.multicall({ allowFailure: true, contracts: queueCalls }) : Promise.resolve([]),
  ]);
  const assetDecimals = typeof assetMeta[0].result === "number" ? assetMeta[0].result : 18;
  const assetSymbol = typeof assetMeta[1].result === "string" ? assetMeta[1].result : "asset";
  const marketIds = (queue as { result?: string }[]).map((r) => r.result).filter((x): x is string => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x));

  // Round 3: for each market — the vault's supplied assets, the market totals,
  // and the market params (LLTV + collateral token).
  const perMarket = await client.multicall({
    allowFailure: true,
    contracts: marketIds.flatMap((id) => [
      { address: MORPHO_BLUE, abi: morphoAbi, functionName: "position" as const, args: [id as `0x${string}`, v] as const },
      { address: MORPHO_BLUE, abi: morphoAbi, functionName: "market" as const, args: [id as `0x${string}`] as const },
      { address: MORPHO_BLUE, abi: morphoAbi, functionName: "idToMarketParams" as const, args: [id as `0x${string}`] as const },
    ]),
  });

  const allocations: { market: string; collateralToken: string; liquidationLtvPct: number; supplied: bigint }[] = [];
  for (let i = 0; i < marketIds.length; i++) {
    const pos = perMarket[i * 3].result as readonly [bigint, bigint, bigint] | undefined;
    const mk = perMarket[i * 3 + 1].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined;
    const mp = perMarket[i * 3 + 2].result as readonly [string, string, string, string, bigint] | undefined;
    if (!pos || !mk || !mp) continue;
    const supplyShares = pos[0];
    const [totalSupplyAssets, totalSupplyShares] = mk;
    const supplied = totalSupplyShares > 0n ? (supplyShares * totalSupplyAssets) / totalSupplyShares : 0n;
    if (supplied === 0n) continue; // market in the queue but nothing allocated
    allocations.push({
      market: marketIds[i],
      collateralToken: mp[1] === ZERO ? "idle" : getAddress(mp[1]),
      liquidationLtvPct: +(Number(mp[4] / 10n ** 14n) / 100).toFixed(2),
      supplied,
    });
  }

  // Collateral symbols (one more round, only for the markets that hold funds).
  const collAddrs = allocations.filter((a) => a.collateralToken !== "idle").map((a) => a.collateralToken);
  const symByAddr = new Map<string, string>();
  if (collAddrs.length) {
    const syms = await client.multicall({ allowFailure: true, contracts: collAddrs.map((c) => ({ address: c as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const })) });
    collAddrs.forEach((c, i) => { if (typeof syms[i].result === "string") symByAddr.set(c.toLowerCase(), syms[i].result as string); });
  }

  const allocated = allocations.reduce((a, x) => a + x.supplied, 0n);
  const idle = totalAssets > allocated ? totalAssets - allocated : 0n;
  allocations.sort((a, b) => (b.supplied > a.supplied ? 1 : -1));
  const denom = totalAssets > 0n ? totalAssets : 1n;
  const markets = allocations.map((a) => ({
    market: a.market,
    collateral: a.collateralToken === "idle" ? "idle" : (symByAddr.get(a.collateralToken.toLowerCase()) ?? a.collateralToken),
    liquidationLtvPct: a.liquidationLtvPct,
    supplied: `${fmt(a.supplied, assetDecimals)} ${assetSymbol}`,
    sharePct: +((100 * Number(a.supplied)) / Number(denom)).toFixed(1),
  }));

  const concentrationPct = markets[0]?.sharePct ?? 0;
  const idlePct = +((100 * Number(idle)) / Number(denom)).toFixed(1);
  const feePct = +(Number(feeRaw) / Number(WAD) * 100).toFixed(1);
  const timelockH = Math.round(Number(timelock) / 3600);
  // Highest-LLTV market carrying real weight = the riskiest allocation.
  const riskiest = [...markets].filter((m) => m.collateral !== "idle").sort((a, b) => b.liquidationLtvPct - a.liquidationLtvPct)[0];
  const soleControl = curator && owner && curator.toLowerCase() === owner.toLowerCase();

  const verdict =
    markets.length === 0 ? "no_allocation"
    : concentrationPct >= 70 ? "concentrated"
    : feePct >= 20 || (soleControl && timelockH === 0) ? "control_risk"
    : "diversified";

  return finish({
    vault: v,
    name,
    asset: getAddress(asset),
    assetSymbol,
    totalAssets: `${fmt(totalAssets, assetDecimals)} ${assetSymbol}`,
    verdict, // diversified | concentrated | control_risk | no_allocation
    marketCount: markets.length,
    concentrationPct, // share in the single largest market
    idlePct,
    feePct,
    timelockHours: timelockH,
    curator,
    owner,
    guardian: guardian && guardian !== ZERO ? getAddress(guardian) : null,
    soleControl, // curator == owner: one party sets allocations and governs
    riskiestMarket: riskiest ? { collateral: riskiest.collateral, liquidationLtvPct: riskiest.liquidationLtvPct, sharePct: riskiest.sharePct } : null,
    markets,
    recommendation:
      verdict === "no_allocation"
        ? `This vault holds ${fmt(totalAssets, assetDecimals)} ${assetSymbol} but has nothing allocated to Morpho markets right now (100% idle) — either freshly deployed or fully withdrawn. Nothing earning yet.`
        : verdict === "concentrated"
          ? `⚠️ Concentrated: ${concentrationPct}% of deposits sit in a single market (${markets[0]?.collateral} collateral, ${markets[0]?.liquidationLtvPct}% liq. LTV). A problem in that one market hits most of the vault. Weigh that before depositing.`
          : verdict === "control_risk"
            ? `Governance flags: ${feePct}% performance fee${soleControl ? ", curator and owner are the same address (one party sets allocations AND governs)" : ""}${timelockH === 0 ? ", zero timelock (changes take effect instantly)" : ""}. Functional, but the control setup concentrates trust — review who that party is.`
            : `Diversified across ${markets.length} market(s), largest ${concentrationPct}%, ${idlePct}% idle, ${feePct}% fee, ${timelockH}h timelock. Riskiest allocation: ${riskiest?.collateral} at ${riskiest?.liquidationLtvPct}% liq. LTV.`,
    note: "Reads a Base MetaMorpho vault's depositor risk: allocation across Morpho Blue markets (concentration, per-market collateral + liquidation LTV), idle share, performance fee, timelock, and who controls it (curator/owner/guardian). The depositor-side complement to morpho-health. vault= required. Not financial advice.",
  });
}
