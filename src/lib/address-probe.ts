/**
 * address-probe — the onchain half of address labelling: things that can be
 * detected generically, without a list.
 *
 *   ERC-4626 vault  asset() answers with an address
 *   Safe multisig   getThreshold() answers (a group wallet — it can sell)
 *   pool interface  token0() and token1() both answer (Uniswap v2/v3, Aerodrome,
 *                   Slipstream and their forks all expose these)
 *   contract vs EOA eth_getCode; an EIP-7702 delegation (0xef0100‖target) is
 *                   reported as an EOA with a delegate, not as a contract
 *
 * A read that fails is "not detected", never a positive. Labels only come from
 * the sourced registry (known-addresses.ts) or from these interface reads.
 */

import "server-only";
import { createPublicClient, getAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { lookupKnown, KNOWN_ADDRESSES_CHECKED_AT, type KnownAddress } from "./known-addresses";

const client = createPublicClient({ chain: base, transport: baseTransport(5000, true) });

const ABI = parseAbi([
  "function asset() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function symbol() view returns (string)",
  "function getThreshold() view returns (uint256)",
]);

async function read<T>(address: Address, functionName: "asset" | "token0" | "token1" | "symbol" | "getThreshold"): Promise<T | null> {
  try {
    return (await client.readContract({ address, abi: ABI, functionName })) as T;
  } catch {
    return null;
  }
}

/**
 * Which of `candidates` are ERC-4626 vaults whose asset() is `token`.
 * Returns lowercased addresses. Any failed read leaves that candidate out —
 * the conservative direction (it stays counted as dumpable).
 */
export async function probeVaultsForToken(token: string, candidates: string[]): Promise<Set<string>> {
  const t = token.toLowerCase();
  const out = new Set<string>();
  const list = [...new Set(candidates.map((c) => c.toLowerCase()))].filter((c) => /^0x[0-9a-f]{40}$/.test(c)).slice(0, 10);
  const res = await Promise.allSettled(list.map((c) => read<string>(getAddress(c), "asset")));
  res.forEach((r, i) => {
    if (r.status === "fulfilled" && typeof r.value === "string" && r.value.toLowerCase() === t) out.add(list[i]);
  });
  return out;
}

export async function describeAddress(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… Base address");
  const address = getAddress(raw);
  const known: KnownAddress | null = lookupKnown(address);

  let code: string | undefined;
  try {
    code = (await client.getCode({ address })) ?? "0x";
  } catch {
    throw new Error("Base RPC unavailable — could not read the address; not charged, retry shortly");
  }
  const hex = (code || "0x").toLowerCase();
  const delegation = hex.startsWith("0xef0100") && hex.length === 2 + 23 * 2 ? getAddress(`0x${hex.slice(8)}`) : null;
  const isContract = hex !== "0x" && !delegation;

  let erc4626: { asset: string; assetSymbol: string | null } | null = null;
  let pool: { token0: string; token1: string } | null = null;
  let safe: { threshold: number } | null = null;
  if (isContract) {
    const [asset, t0, t1, threshold] = await Promise.all([
      read<string>(address, "asset"),
      read<string>(address, "token0"),
      read<string>(address, "token1"),
      read<bigint>(address, "getThreshold"),
    ]);
    if (typeof threshold === "bigint" && threshold > 0n && threshold < 100n) safe = { threshold: Number(threshold) };
    if (asset && /^0x[0-9a-fA-F]{40}$/.test(asset) && asset !== "0x0000000000000000000000000000000000000000") {
      erc4626 = { asset: getAddress(asset), assetSymbol: await read<string>(getAddress(asset), "symbol") };
    }
    if (t0 && t1) pool = { token0: getAddress(t0), token1: getAddress(t1) };
  }

  const detected: string[] = [];
  if (erc4626) detected.push(`ERC-4626 vault (asset ${erc4626.assetSymbol ?? erc4626.asset})`);
  if (pool) detected.push("DEX pool interface (token0/token1)");
  if (safe) detected.push(`Safe multisig interface (getThreshold = ${safe.threshold})`);

  const kind = known
    ? known.kind
    : erc4626
      ? "vault"
      : pool
        ? "dex pool"
        : safe
          ? "multisig"
          : isContract
            ? "unknown contract"
            : delegation
              ? "eoa (EIP-7702 delegated)"
              : "eoa";

  const label = known
    ? known.label
    : erc4626
      ? "ERC-4626 vault"
      : pool
        ? "DEX pool"
        : safe
          ? `Safe multisig (${safe.threshold}-of-N)`
          : isContract
            ? "unknown contract"
            : "unlabelled wallet (EOA)";

  return {
    address,
    label,
    kind, // lending | dex | bridge | cex | vesting/locker | burn | protocol-treasury | vault | dex pool | multisig | unknown contract | eoa
    known: known
      ? { label: known.label, kind: known.kind, source: known.source, registryCheckedAt: KNOWN_ADDRESSES_CHECKED_AT }
      : null,
    isContract,
    ...(delegation ? { eip7702Delegate: delegation } : {}),
    erc4626,
    pool,
    safe,
    detected,
    holderMeaning:
      kind === "multisig"
        ? "Multisig wallet (Safe) — a team, treasury or individual group; it can sell."
        : kind === "cex"
        ? "Exchange wallet — pooled user funds. Not one holder's bag, but the exchange can sell deposits."
        : kind === "protocol-treasury"
          ? "Protocol treasury — governance-controlled; can sell."
          : ["lending", "dex", "bridge", "vesting/locker", "burn", "vault", "dex pool"].includes(kind)
            ? "Infrastructure — tokens held here are pooled, escrowed, locked or burnt, not one party's sellable bag."
            : kind === "unknown contract"
              ? "Unlabelled contract — could be a protocol or a team multisig that can sell."
              : "Unlabelled wallet — treat as a holder who can sell.",
    note: "Registry entries are sourced (protocol docs / deployments files / Basescan public name tags, URL in known.source) and were code-checked on Base. Vault and pool are detected from interface reads, not from a list. An address with no match is reported as unlabelled, never guessed.",
    checkedAt: new Date().toISOString(),
  };
}
