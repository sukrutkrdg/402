/**
 * Safe Check — multisig / treasury intelligence for a Base address.
 *
 * A huge share of Base treasuries, DAOs and app-operated wallets are Gnosis
 * Safes. Before an agent transacts with, or trusts funds to, a counterparty it
 * wants to know: is this a real M-of-N multisig or a 1-of-1 that only looks like
 * one? And critically — what MODULES are enabled? An enabled Safe module can
 * move the Safe's funds via execTransactionFromModule WITHOUT collecting any
 * owner signatures, so every module is an address with unilateral control, the
 * same drain surface a rogue 7702 delegate is for an EOA. This reads owners,
 * threshold, version, activity and the module list in one call. No other Base
 * tool surfaces multisig control + module risk for an agent. Not financial advice.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { finish } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const SENTINEL = "0x0000000000000000000000000000000000000001";

// Conservative labels for well-known Safe modules. An unlabeled module is
// reported by address with the generic "can execute without owner signatures"
// warning rather than guessed.
const KNOWN_MODULES: Record<string, string> = {
  "0xcfbfac74c26f8647cbdb8c5caf80bb5b32e43134": "Safe Allowance Module (spending limits)",
  "0xa581c4a4db7175302464ff3c06380bc3270b4037": "Safe4337Module (ERC-4337 / account abstraction)",
  "0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226": "Safe4337Module (ERC-4337 / account abstraction)",
};

const safeAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getModulesPaginated", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "address[]" }, { type: "address" }] },
] as const;

export async function safeCheck(params: Record<string, string>) {
  const addr = (params.address || params.safe || params.wallet || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("Provide a valid 0x... address (address=)");
  const a = getAddress(addr);

  const res = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: a, abi: safeAbi, functionName: "getOwners" },
      { address: a, abi: safeAbi, functionName: "getThreshold" },
      { address: a, abi: safeAbi, functionName: "VERSION" },
      { address: a, abi: safeAbi, functionName: "nonce" },
      { address: a, abi: safeAbi, functionName: "getModulesPaginated", args: [SENTINEL, 100n] },
    ],
  });
  const owners = res[0].result as readonly string[] | undefined;
  const threshold = res[1].result as bigint | undefined;

  // A Safe answers getOwners AND getThreshold; anything else is not a Safe.
  if (!owners || owners.length === 0 || threshold === undefined) {
    return finish({
      address: a,
      isSafe: false,
      verdict: "not_a_safe",
      recommendation: "This address is not a Gnosis Safe (getOwners/getThreshold don't respond) — it's an EOA, a different smart-account type, or a plain contract. For EOA control checks use wallet-delegation / agent-wallet-audit.",
      note: "Reads Gnosis Safe multisig config on Base: owners, M-of-N threshold, version, activity and enabled modules (unilateral-execution drain surface). address= required. Not financial advice.",
    });
  }

  const version = typeof res[2].result === "string" ? res[2].result : "unknown";
  const nonce = res[3].result as bigint | undefined;
  const modRes = res[4].result as readonly [readonly string[], string] | undefined;
  // CRITICAL: distinguish "no modules" from "couldn't read modules". A failed
  // getModulesPaginated (undefined) must NOT collapse to [] and report a clean
  // "no modules = safest" verdict — that's the exact false all-clear this tool
  // exists to prevent (a hidden draining module reading as maximally safe).
  const modulesRead = modRes !== undefined;
  const modules = (modRes?.[0] ?? []).map((m) => getAddress(m));
  // The paginated `next` cursor: anything other than the sentinel or 0 means more
  // modules exist beyond this page than we read.
  const nextCursor = (modRes?.[1] ?? SENTINEL).toLowerCase();
  const modulesTruncated = modulesRead && nextCursor !== SENTINEL && nextCursor !== "0x0000000000000000000000000000000000000000";
  const ownerList = owners.map((o) => getAddress(o));
  const m = Number(threshold);
  const nOwners = ownerList.length;

  const moduleDetail = modules.map((mod) => ({
    module: mod,
    label: KNOWN_MODULES[mod.toLowerCase()] ?? null,
    known: mod.toLowerCase() in KNOWN_MODULES,
  }));
  const unknownModules = moduleDetail.filter((x) => !x.known).length;

  const singleSigner = m <= 1;
  const hasModules = modules.length > 0;
  const verdict = !modulesRead
    ? "modules_unknown"
    : hasModules ? "has_modules" : singleSigner ? "single_signer" : "multisig";

  return finish({
    address: a,
    isSafe: true,
    version,
    verdict, // multisig | single_signer | has_modules | modules_unknown | not_a_safe
    threshold: `${m}/${nOwners}`,
    ownerCount: nOwners,
    owners: ownerList.slice(0, 20),
    moduleCount: modulesRead ? modules.length : null,
    modules: moduleDetail,
    unknownModules,
    ...(modulesTruncated ? { modulesTruncated: true } : {}),
    txCount: nonce !== undefined ? Number(nonce) : null,
    recommendation:
      verdict === "modules_unknown"
        ? `⚠️ This IS a Safe (${m}/${nOwners}), but its enabled MODULES couldn't be read (getModulesPaginated failed — possibly an older Safe mastercopy). An enabled module can move funds WITHOUT owner signatures, so this is NOT an all-clear: don't assume it's module-free. Retry, or inspect modules on a Safe explorer before trusting funds here.`
        : verdict === "has_modules"
          ? `⚠️ This Safe (${m}/${nOwners}) has ${modules.length}${modulesTruncated ? "+" : ""} enabled MODULE(S)${unknownModules ? ` — ${unknownModules} unrecognized` : ""}. Each module can move the Safe's funds via execTransactionFromModule WITHOUT any owner signatures, so the ${m}/${nOwners} threshold is only as strong as the modules are trustworthy. ${singleSigner ? "Combined with a 1-signer threshold, control is highly concentrated. " : ""}Identify every module before trusting funds here.`
          : verdict === "single_signer"
            ? `This is a 1-of-${nOwners} Safe — a single signature moves the funds. It's a smart account with Safe's tooling, not a real multisig; treat its security like a single key, not an M-of-N.`
            : `Healthy multisig: ${m}-of-${nOwners}, no modules enabled, ${nonce !== undefined ? `${Number(nonce)} txs` : "active"}. Moving funds needs ${m} of ${nOwners} owner signatures and nothing can bypass that — the strongest counterparty setup.`,
    note: "Reads Gnosis Safe multisig config on Base: is it a Safe, owners + M-of-N threshold, version, tx count, and enabled MODULES — each of which can execute without owner signatures (the multisig's real drain surface). The counterparty/treasury check no other Base tool serves. address= required. Not financial advice.",
  });
}
