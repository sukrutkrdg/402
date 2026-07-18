/**
 * EIP-7702 Delegation Check — is this EOA secretly a smart account, and who
 * controls the code it runs?
 *
 * Since Pectra, an EOA can sign a 7702 authorization that installs a delegation
 * designator (0xef0100 ++ 20-byte address) as its code: every call to the EOA
 * then executes the DELEGATE's code with the EOA's storage and funds. A
 * malicious delegate is total wallet takeover — approvals, balances, everything
 * — with no further signatures. Base's own path (base/eip-7702-proxy) upgrades
 * EOAs to CoinbaseSmartWallet; anything else deserves scrutiny. No other x402
 * tool reads this surface.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { finish } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

// Known-good delegates/infra from base/eip-7702-proxy (README deployment table).
const KNOWN_DELEGATES: Record<string, string> = {
  "0x7702cb554e6bfb442cb743a7df23154544a7176c": "EIP7702Proxy (Coinbase — upgrades the EOA to CoinbaseSmartWallet)",
  "0x000100abaad02f1cfc8bbe32bd5a564817339e72": "CoinbaseSmartWallet implementation",
  "0x2a8010a9d71d2a5aea19d040f8b4797789a194a9": "Coinbase 7702 infrastructure (base/eip-7702-proxy)",
  "0x79a33f950b90c7d07e66950daedf868bd0cdcf96": "Coinbase 7702 infrastructure (base/eip-7702-proxy)",
  "0xd0ff13c28679fdd75bc09c0a430a0089bf8b95a8": "Coinbase 7702 infrastructure (base/eip-7702-proxy)",
  // Selector fingerprint (hashTypedDataSansChainId, removeOwner(bytes32), getHook)
  // matches the CoinbaseSmartWallet family — the standard Base App 7702 upgrade.
  "0x36d3cbd83961868398d056efbf50f5ce15528c0d": "Base Account (CoinbaseSmartWallet v2 implementation)",
};

export interface DelegationInfo {
  state: "not_delegated" | "delegated" | "smart_contract" | "unknown";
  delegate: string | null;
  delegateLabel: string | null;
  delegateKnown: boolean;
  delegateHasCode: boolean | null;
}

/** Shared read: classify an address's code as EOA / 7702-delegated / contract. */
export async function read7702(wallet: `0x${string}`): Promise<DelegationInfo> {
  let code: string | undefined;
  try {
    code = await client.getCode({ address: wallet });
  } catch {
    try {
      await new Promise((r) => setTimeout(r, 300));
      code = await client.getCode({ address: wallet });
    } catch {
      return { state: "unknown", delegate: null, delegateLabel: null, delegateKnown: false, delegateHasCode: null };
    }
  }
  if (!code || code === "0x") {
    return { state: "not_delegated", delegate: null, delegateLabel: null, delegateKnown: false, delegateHasCode: null };
  }
  if (!code.toLowerCase().startsWith("0xef0100")) {
    return { state: "smart_contract", delegate: null, delegateLabel: null, delegateKnown: false, delegateHasCode: null };
  }
  let delegate: string;
  try {
    delegate = getAddress("0x" + code.slice(8, 48));
  } catch {
    return { state: "unknown", delegate: null, delegateLabel: null, delegateKnown: false, delegateHasCode: null };
  }
  const label = KNOWN_DELEGATES[delegate.toLowerCase()] ?? null;
  let delegateHasCode: boolean | null = null;
  try {
    const dc = await client.getCode({ address: delegate as `0x${string}` });
    delegateHasCode = Boolean(dc && dc !== "0x");
  } catch {
    /* cosmetic — leave null */
  }
  return { state: "delegated", delegate, delegateLabel: label, delegateKnown: label !== null, delegateHasCode };
}

export async function walletDelegation(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x… wallet address (wallet=)");
  const w = getAddress(wallet);

  const d = await read7702(w);
  if (d.state === "unknown") throw new Error("Delegation read unavailable (RPC) — try again shortly");

  const verdict =
    d.state === "not_delegated"
      ? "not_delegated"
      : d.state === "smart_contract"
        ? "smart_contract"
        : d.delegateKnown
          ? "delegated_known"
          : "delegated_unknown";

  return finish({
    wallet: w,
    verdict, // not_delegated | delegated_known | delegated_unknown | smart_contract
    delegated: d.state === "delegated",
    delegate: d.delegate,
    delegateLabel: d.delegateLabel,
    delegateHasCode: d.delegateHasCode,
    recommendation:
      verdict === "delegated_unknown"
        ? `🚨 This EOA is 7702-delegated to an UNRECOGNIZED contract (${d.delegate}). Every call to the wallet runs that contract's code with the wallet's funds — a malicious delegate is total takeover with no further signatures. If you don't recognize it, treat the wallet as compromised: move funds out and clear the delegation (sign a 7702 authorization to address(0)).`
        : verdict === "delegated_known"
          ? `Delegated to known Coinbase 7702 infrastructure: ${d.delegateLabel}. This is the standard EOA→CoinbaseSmartWallet upgrade path — expected on upgraded Base accounts.`
          : verdict === "smart_contract"
            ? "This address holds regular contract bytecode — it's a deployed contract (or pre-7702 smart wallet), not a delegated EOA. Audit it as a contract (contract-danger)."
            : "No code on this EOA — no 7702 delegation is active. Calls to it can't execute anyone else's logic.",
    note: "Reads the EIP-7702 delegation designator (0xef0100 + address) on an EOA — whether the account secretly executes someone else's code, and whether that delegate is Base's known CoinbaseSmartWallet path or an unrecognized contract (the total-takeover drain vector approval tools can't see). Not financial advice.",
  });
}
