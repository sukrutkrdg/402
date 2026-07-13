/**
 * Basename resolver — forward (name → address) and reverse (address → name)
 * resolution for Base's Basenames, read directly from the Base L2 Resolver.
 *
 * Agents constantly need to turn human-readable names like `jesse.base.eth`
 * into addresses (and back), so this is a natural pay-per-call utility.
 */

import "server-only";
import {
  createPublicClient,
  http,
  namehash,
  keccak256,
  encodePacked,
  stringToBytes,
  getAddress,
  type Address,
} from "viem";
import { base, mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { getConfig } from "./config";
import { baseTransport } from "./base-transport";

// Base mainnet Basenames L2 Resolver.
const L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

const resolverAbi = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }],
    outputs: [{ type: "string" }],
  },
] as const;

function client() {
  return createPublicClient({ chain: base, transport: baseTransport(8000) });
}

// ENSIP-11 coinType for a chain id (Base mainnet 8453 → 0x80002105).
function chainCoinType(chainId: number): string {
  return ((0x80000000 | chainId) >>> 0).toString(16).toUpperCase();
}

// Reverse-resolution node for an address under Base's coinType namespace.
function reverseNode(address: string, chainId: number): `0x${string}` {
  const label = address.toLowerCase().slice(2); // 40-hex, no 0x
  const addressNode = keccak256(stringToBytes(label));
  const baseReverseNode = namehash(`${chainCoinType(chainId)}.reverse`);
  return keccak256(encodePacked(["bytes32", "bytes32"], [baseReverseNode, addressNode]));
}

/**
 * basenameResolve — resolve a Basename to an address, or an address to its
 * primary Basename. Pass either form in `query` (or `name` / `address`).
 */
export async function basenameResolve(params: Record<string, string>) {
  const q = (params.query || params.name || params.address || "").trim();
  if (!q) throw new Error("Provide a 'query' — a Basename (jesse.base.eth) or a 0x address");
  const c = client();
  const checkedAt = new Date().toISOString();

  // ---- Reverse: address → name ----
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const address = getAddress(q);
    let name = "";
    try {
      name = (await c.readContract({
        address: L2_RESOLVER,
        abi: resolverAbi,
        functionName: "name",
        args: [reverseNode(address, 8453)],
      })) as string;
    } catch {
      /* no reverse record */
    }
    return {
      query: q,
      direction: "reverse" as const,
      address,
      basename: name || null,
      resolved: Boolean(name),
      checkedAt,
    };
  }

  // ---- Forward: name → address ----
  let name = q.toLowerCase();
  if (!name.includes(".")) name = `${name}.base.eth`; // bare label → .base.eth
  let addr = ZERO;
  try {
    addr = (await c.readContract({
      address: L2_RESOLVER,
      abi: resolverAbi,
      functionName: "addr",
      args: [namehash(name)],
    })) as string;
  } catch {
    /* unresolved */
  }
  const resolved = Boolean(addr) && addr.toLowerCase() !== ZERO;
  return {
    query: q,
    direction: "forward" as const,
    basename: name,
    address: resolved ? (getAddress(addr) as Address) : null,
    resolved,
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// ENS (Ethereum mainnet) resolution — complements Basenames.
// ---------------------------------------------------------------------------

function mainnetClient() {
  return createPublicClient({ chain: mainnet, transport: http(undefined, { timeout: 8000 }) });
}

/**
 * ensResolve — resolve a mainnet ENS name to an address, or an address to its
 * primary ENS name. Pass either in `query` (or `name` / `address`).
 */
export async function ensResolve(params: Record<string, string>) {
  const q = (params.query || params.name || params.address || "").trim();
  if (!q) throw new Error("Provide a 'query' — a .eth name or 0x address");
  const c = mainnetClient();
  const checkedAt = new Date().toISOString();

  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const address = getAddress(q);
    let name: string | null = null;
    try {
      name = await c.getEnsName({ address });
    } catch {
      /* no reverse record */
    }
    return { query: q, direction: "reverse" as const, address, ensName: name || null, resolved: Boolean(name), checkedAt };
  }

  let address: string | null = null;
  try {
    address = await c.getEnsAddress({ name: normalize(q.toLowerCase()) });
  } catch {
    /* unresolved */
  }
  return {
    query: q,
    direction: "forward" as const,
    ensName: q.toLowerCase(),
    address: address ? (getAddress(address) as Address) : null,
    resolved: Boolean(address),
    checkedAt,
  };
}

/**
 * basenameProfile — the full onchain identity behind a Basename or address:
 * resolved address, avatar, description, url and social handles (twitter, github,
 * farcaster, discord) read from Base's L2 Resolver text records. Lets an agent
 * resolve who a counterparty is beyond just the name.
 */
export async function basenameProfile(params: Record<string, string>) {
  const q = (params.name || params.query || params.address || "").trim();
  if (!q) throw new Error("Provide a Basename (name=) or a 0x address");
  const c = client();
  const checkedAt = new Date().toISOString();

  let name = q;
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const address = getAddress(q);
    try {
      name = (await c.readContract({ address: L2_RESOLVER, abi: resolverAbi, functionName: "name", args: [reverseNode(address, 8453)] })) as string;
    } catch {
      name = "";
    }
    if (!name) return { address, basename: null, hasProfile: false, note: "No primary Basename set for this address.", checkedAt };
  }

  let norm: string;
  try {
    norm = normalize(name);
  } catch {
    throw new Error("Invalid Basename");
  }
  const node = namehash(norm);

  const KEYS = ["avatar", "description", "url", "com.twitter", "com.github", "xyz.farcaster", "com.discord", "email", "location"];
  const calls = [
    { address: L2_RESOLVER, abi: resolverAbi, functionName: "addr", args: [node] },
    ...KEYS.map((k) => ({ address: L2_RESOLVER, abi: resolverAbi, functionName: "text", args: [node, k] })),
  ];
  let results;
  try {
    results = await c.multicall({ contracts: calls as never, allowFailure: true });
  } catch {
    throw new Error("Basename profile unavailable (RPC) — try again shortly");
  }
  const val = (i: number) => {
    const r = (results as Array<{ status?: string; result?: unknown }>)[i];
    return r?.status === "success" ? String(r.result ?? "") : "";
  };
  const addr = val(0);
  const records: Record<string, string> = {};
  KEYS.forEach((k, i) => {
    const v = val(i + 1);
    if (v) records[k] = v;
  });

  const socials: Record<string, string> = {};
  if (records["com.twitter"]) socials.twitter = records["com.twitter"];
  if (records["com.github"]) socials.github = records["com.github"];
  if (records["xyz.farcaster"]) socials.farcaster = records["xyz.farcaster"];
  if (records["com.discord"]) socials.discord = records["com.discord"];

  return {
    basename: norm,
    address: /^0x[0-9a-fA-F]{40}$/.test(addr) && addr.toLowerCase() !== ZERO ? getAddress(addr) : null,
    avatar: records.avatar || null,
    description: records.description || null,
    url: records.url || null,
    socials,
    hasProfile: Object.keys(records).length > 0,
    records,
    note: "Full Basename profile (address + avatar + socials + text records) read from Base's L2 Resolver. Lets an agent resolve a counterparty's onchain identity. Not financial advice.",
    checkedAt,
  };
}
