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

/** Token Risk Check — pre-trade safety signals for a Base token. */
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

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    read("name"),
    read("symbol"),
    read("decimals"),
    read("totalSupply"),
  ]);

  const flags: string[] = [];
  const isErc20 = symbol !== undefined && decimals !== undefined && totalSupply !== undefined;
  if (!isErc20) flags.push("not_standard_erc20");

  // Ownership
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
    if (slot && BigInt(slot) !== 0n) {
      upgradeableProxy = true;
      flags.push("upgradeable_proxy");
    }
  } catch {
    /* ignore */
  }

  let score = 0;
  if (flags.includes("not_standard_erc20")) score += 40;
  if (flags.includes("owner_not_renounced")) score += 35;
  if (flags.includes("upgradeable_proxy")) score += 30;
  score = Math.min(score, 100);
  const riskLevel = score >= 70 ? "high" : score >= 35 ? "medium" : "low";

  return {
    address,
    isContract: true,
    token: {
      name: name ?? null,
      symbol: symbol ?? null,
      decimals: decimals !== undefined ? Number(decimals) : null,
      totalSupply: totalSupply !== undefined ? String(totalSupply) : null,
    },
    ownership: owner
      ? { owner, renounced }
      : { owner: null, renounced: null, note: "No owner()/getOwner() function found" },
    upgradeableProxy,
    riskScore: score,
    riskLevel,
    flags,
    coverage:
      "v1 (RPC-only): contract, ERC-20 conformance, ownership renounce, EIP-1967 proxy. v2: honeypot simulation + holder concentration.",
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
