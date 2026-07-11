/**
 * On-chain intelligence services (the flagship "valuable" endpoints).
 *
 * Built entirely from public Base RPC — no upstream API cost, so margins are
 * ~100%. These are exactly what trading bots / AI agents need to check before
 * touching a token or counterparty, which is what makes them genuinely demanded
 * pay-per-call utilities.
 *
 * v1 is RPC-only (contract + ERC-20 + ownership + proxy checks). Honeypot
 * simulation and holder-concentration land in v2 (optional BaseScan key).
 */

import "server-only";
import { goPlusSecurity } from "./upstream-cache";
import { createPublicClient, http, getAddress, formatEther, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { getConfig, USDC_BASE } from "./config";
import { baseTransport } from "./base-transport";

const DEAD = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);
// EIP-1967 implementation slot — non-zero means an upgradeable proxy.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ownerAbis = [
  [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
  [{ type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
] as const;

function client() {
  return createPublicClient({ chain: base, transport: baseTransport(8000) });
}

function requireAddress(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

type GoPlus = Record<string, unknown>;

/** Free public token-security data (honeypot, taxes, holders). Returns null on failure. */
async function fetchGoPlus(address: string): Promise<GoPlus | null> {
  return (await goPlusSecurity<GoPlus>(address)) ?? null;
}

const isTrue = (v: unknown) => v === "1" || v === 1 || v === true;
const num = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** Token Risk Check v2 — RPC base + public security enrichment (honeypot, taxes, holders). */
export async function tokenRisk(params: Record<string, string>) {
  const address = requireAddress(params.address || "");
  const c = client();

  let code: `0x${string}` | undefined;
  try {
    code = await c.getCode({ address });
  } catch (err) {
    throw new Error(`Token data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  let atBlock: string | null = null;
  try {
    atBlock = (await c.getBlockNumber()).toString();
  } catch {
    atBlock = null;
  }
  if (!code || code === "0x") {
    return {
      address,
      isContract: false,
      riskScore: 100,
      riskLevel: "high" as const,
      flags: ["not_a_contract"],
      note: "Address has no code — it's an EOA, not a token contract.",
      checkedAt: new Date().toISOString(),
    };
  }

  const read = async (fn: string, args: unknown[] = []) => {
    try {
      return await c.readContract({ address, abi: erc20Abi, functionName: fn as never, args: args as never });
    } catch {
      return undefined;
    }
  };

  // RPC base (authoritative, live) + GoPlus security (honeypot/taxes/holders) in parallel
  const [name, symbol, decimals, totalSupply, gp] = await Promise.all([
    read("name"),
    read("symbol"),
    read("decimals"),
    read("totalSupply"),
    fetchGoPlus(address),
  ]);

  const flags: string[] = [];
  const isErc20 = symbol !== undefined && decimals !== undefined && totalSupply !== undefined;
  if (!isErc20) flags.push("not_standard_erc20");

  // Ownership (RPC)
  let owner: string | undefined;
  for (const abi of ownerAbis) {
    try {
      owner = (await c.readContract({ address, abi, functionName: abi[0].name as never })) as string;
      break;
    } catch {
      /* try next */
    }
  }
  let renounced: boolean | null = null;
  if (owner) {
    renounced = DEAD.has(owner.toLowerCase());
    if (!renounced) flags.push("owner_not_renounced");
  }

  // Upgradeable proxy (EIP-1967)
  let upgradeableProxy = false;
  try {
    const slot = await c.getStorageAt({ address, slot: IMPL_SLOT });
    if (slot && BigInt(slot) !== 0n) upgradeableProxy = true;
  } catch {
    /* ignore */
  }

  // --- scoring ---
  let score = 0;
  if (flags.includes("not_standard_erc20")) score += 40;
  if (flags.includes("owner_not_renounced")) score += 15;
  if (upgradeableProxy) { flags.push("upgradeable_proxy"); score += 15; }

  // GoPlus security enrichment
  let security: Record<string, unknown> | null = null;
  if (gp) {
    const buyTax = num(gp.buy_tax) * 100;
    const sellTax = num(gp.sell_tax) * 100;
    const topHolderPct = Array.isArray(gp.holders) && gp.holders[0]
      ? num((gp.holders[0] as GoPlus).percent) * 100
      : null;

    // --- Deeper holder/LP analysis ---

    // top10HolderPct: sum of percent for first up to 10 holders (×100, rounded to 2 dp)
    let top10HolderPct: number | null = null;
    if (Array.isArray(gp.holders) && gp.holders.length > 0) {
      const slice = (gp.holders as GoPlus[]).slice(0, 10);
      top10HolderPct = Math.round(
        slice.reduce((acc, h) => acc + num(h.percent), 0) * 100 * 100,
      ) / 100;
    }

    // lockedLpPct: sum of percent where is_locked truthy OR holder is a burn/dead address (×100)
    let lockedLpPct: number | null = null;
    if (Array.isArray(gp.lp_holders) && gp.lp_holders.length > 0) {
      const burnAddrs = new Set([
        "0x0000000000000000000000000000000000000000",
        "0x000000000000000000000000000000000000dead",
      ]);
      lockedLpPct =
        Math.round(
          (gp.lp_holders as GoPlus[]).reduce((acc, h) => {
            const addr = String(h.address ?? "").toLowerCase();
            const locked = isTrue(h.is_locked) || burnAddrs.has(addr);
            return acc + (locked ? num(h.percent) : 0);
          }, 0) *
            100 *
            100,
        ) / 100;
    }

    // creatorPct: creator_percent × 100
    const creatorPct =
      gp.creator_percent !== undefined ? Math.round(num(gp.creator_percent) * 100 * 100) / 100 : null;

    // isInDex: boolean
    const isInDex = gp.is_in_dex !== undefined ? isTrue(gp.is_in_dex) : null;

    // --- Existing flags ---
    if (isTrue(gp.is_honeypot)) { flags.push("honeypot"); score += 60; }
    if (isTrue(gp.cannot_sell_all)) { flags.push("cannot_sell_all"); score += 40; }
    if (sellTax >= 50) { flags.push("extreme_sell_tax"); score += 40; }
    else if (sellTax >= 10) { flags.push("high_sell_tax"); score += 25; }
    if (buyTax >= 10) { flags.push("high_buy_tax"); score += 15; }
    if (isTrue(gp.transfer_pausable)) { flags.push("transfer_pausable"); score += 20; }
    if (isTrue(gp.is_mintable)) { flags.push("mintable"); score += 15; }
    if (gp.is_open_source !== undefined && !isTrue(gp.is_open_source)) { flags.push("unverified_source"); score += 25; }
    if (isTrue(gp.can_take_back_ownership)) { flags.push("can_take_back_ownership"); score += 25; }
    if (isTrue(gp.hidden_owner)) { flags.push("hidden_owner"); score += 20; }
    if (isTrue(gp.is_blacklisted)) { flags.push("has_blacklist"); score += 15; }
    if (topHolderPct !== null && topHolderPct >= 50) { flags.push("top_holder_over_50pct"); score += 20; }

    // --- New deeper flags (deduplicated via check before push) ---
    if (creatorPct !== null && creatorPct >= 5 && !flags.includes("creator_holds_significant")) {
      flags.push("creator_holds_significant"); score += 10;
    }
    if (top10HolderPct !== null && top10HolderPct >= 70 && !flags.includes("concentrated_holders")) {
      flags.push("concentrated_holders"); score += 15;
    }
    if (Array.isArray(gp.lp_holders) && lockedLpPct !== null && lockedLpPct < 50 && !flags.includes("lp_not_locked")) {
      flags.push("lp_not_locked"); score += 20;
    }
    if (isTrue(gp.is_airdrop_scam) && !flags.includes("airdrop_scam")) {
      flags.push("airdrop_scam"); score += 40;
    }
    if (isInDex === false && !flags.includes("not_listed_on_dex")) {
      flags.push("not_listed_on_dex"); score += 15;
    }

    security = {
      isHoneypot: isTrue(gp.is_honeypot),
      buyTaxPct: buyTax,
      sellTaxPct: sellTax,
      isOpenSource: gp.is_open_source !== undefined ? isTrue(gp.is_open_source) : null,
      isMintable: isTrue(gp.is_mintable),
      transferPausable: isTrue(gp.transfer_pausable),
      canTakeBackOwnership: isTrue(gp.can_take_back_ownership),
      hiddenOwner: isTrue(gp.hidden_owner),
      holderCount: gp.holder_count !== undefined ? Number(gp.holder_count) : null,
      topHolderPct,
      lpHolderCount: gp.lp_holder_count !== undefined ? Number(gp.lp_holder_count) : null,
      // --- New deeper fields ---
      top10HolderPct,
      lockedLpPct,
      creatorPct,
      isInDex,
      // Additional GoPlus booleans
      isAntiWhale: gp.is_anti_whale !== undefined ? isTrue(gp.is_anti_whale) : null,
      antiWhaleModifiable: gp.anti_whale_modifiable !== undefined ? isTrue(gp.anti_whale_modifiable) : null,
      tradingCooldown: gp.trading_cooldown !== undefined ? isTrue(gp.trading_cooldown) : null,
      slippageModifiable: gp.slippage_modifiable !== undefined ? isTrue(gp.slippage_modifiable) : null,
      isTrueToken: gp.is_true_token !== undefined ? isTrue(gp.is_true_token) : null,
      isAirdropScam: gp.is_airdrop_scam !== undefined ? isTrue(gp.is_airdrop_scam) : null,
      creatorAddress: gp.creator_address !== undefined ? String(gp.creator_address) : null,
      creatorBalance: gp.creator_balance !== undefined ? String(gp.creator_balance) : null,
    };
  }

  score = Math.min(score, 100);
  const riskLevel = score >= 70 ? "high" : score >= 35 ? "medium" : "low";

  return {
    address,
    isContract: true,
    token: {
      name: name ?? (gp?.token_name as string) ?? null,
      symbol: symbol ?? (gp?.token_symbol as string) ?? null,
      decimals: decimals !== undefined ? Number(decimals) : null,
      totalSupply: totalSupply !== undefined ? String(totalSupply) : null,
    },
    ownership: owner
      ? { owner, renounced }
      : { owner: null, renounced: null, note: "No owner()/getOwner() function found" },
    upgradeableProxy,
    security,
    riskScore: score,
    riskLevel,
    flags,
    sources: gp ? ["base-rpc", "goplus"] : ["base-rpc"],
    coverage: gp
      ? "RPC base + GoPlus security (honeypot, taxes, holders, holder concentration, LP lock, creator holdings, source, ownership controls)."
      : "RPC-only (security provider unavailable): contract, ERC-20, ownership, proxy.",
    // Pre-spend receipt — an auditable record of this check, so an agent's
    // decision is reviewable after the payment (community-requested).
    receipt: {
      checked: address,
      atBlock,
      at: new Date().toISOString(),
      endpoint: "token-risk",
      decision: riskLevel === "high" ? "STOP" : riskLevel === "medium" ? "HOLD" : "GO",
      observedRisks: flags,
      notChecked: gp
        ? ["offchain team/social signals", "liquidity depth vs your trade size (use swap-route)", "B20 policy powers (use b20-safety)"]
        : ["GoPlus security feed unavailable this call: honeypot/taxes/holders NOT checked", "offchain team/social signals", "liquidity depth vs trade size"],
      wouldChangeCall: security?.isHoneypot
        ? "Nothing — honeypot flag is terminal; do not trade."
        : !renounced
          ? "Ownership renounce, or owner privileges proven inert; re-check before size."
          : "Material change in liquidity, taxes or holder concentration; re-check if stale > 1h.",
      // Machine-readable staleness hint — riskier tokens go stale faster; agents
      // can loop on this to know when to re-check (and re-pay).
      recheckAfter: new Date(Date.now() + (riskLevel === "high" ? 3600_000 : riskLevel === "medium" ? 6 * 3600_000 : 24 * 3600_000)).toISOString(),
    },
    // Funnel: the natural next step after a raw risk check.
    upgrade: {
      service: "ai-token-report",
      price: "$0.12",
      why: "AI-written verdict on this token: buy/avoid call, exit plan, risks explained. If you just paid this check, the full report is $0.05 (not $0.12) on this token for the next hour.",
      url: `https://402.com.tr/api/x402/ai-token-report?address=${address}`,
    },
    checkedAt: new Date().toISOString(),
  };
}

/** Address Intelligence — quick profile of any Base address. */
export async function addressIntel(params: Record<string, string>) {
  const address = requireAddress(params.address || "");
  const c = client();

  let code, balance, nonce;
  try {
    [code, balance, nonce] = await Promise.all([
      c.getCode({ address }),
      c.getBalance({ address }),
      c.getTransactionCount({ address }),
    ]);
  } catch (err) {
    throw new Error(`Address data unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const isContract = Boolean(code && code !== "0x");

  let usdc: bigint | undefined;
  try {
    usdc = (await c.readContract({
      address: USDC_BASE as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  } catch {
    /* ignore */
  }

  return {
    address,
    type: isContract ? "contract" : "eoa",
    ethBalance: formatEther(balance),
    usdcBalance: usdc !== undefined ? formatUnits(usdc, 6) : null,
    txCount: nonce,
    activity: nonce === 0 ? "dormant/fresh" : nonce < 10 ? "low" : nonce < 1000 ? "active" : "very-active",
    checkedAt: new Date().toISOString(),
  };
}
