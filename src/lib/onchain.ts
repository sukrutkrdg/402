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
import { createPublicClient, http, getAddress, formatEther, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { getConfig, USDC_BASE } from "./config";

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
  return createPublicClient({ chain: base, transport: http(getConfig().rpcUrl) });
}

function requireAddress(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

type GoPlus = Record<string, unknown>;

/** Free public token-security data (honeypot, taxes, holders). Returns null on failure. */
async function fetchGoPlus(address: string): Promise<GoPlus | null> {
  try {
    const r = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: Record<string, GoPlus> };
    const row = j.result?.[address.toLowerCase()];
    return row && Object.keys(row).length > 0 ? row : null;
  } catch {
    return null;
  }
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

  const code = await c.getCode({ address });
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
      ? "RPC base + GoPlus security (honeypot, taxes, holders, source, ownership controls)."
      : "RPC-only (security provider unavailable): contract, ERC-20, ownership, proxy.",
    checkedAt: new Date().toISOString(),
  };
}

/** Address Intelligence — quick profile of any Base address. */
export async function addressIntel(params: Record<string, string>) {
  const address = requireAddress(params.address || "");
  const c = client();

  const [code, balance, nonce] = await Promise.all([
    c.getCode({ address }),
    c.getBalance({ address }),
    c.getTransactionCount({ address }),
  ]);
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
