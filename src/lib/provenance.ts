/**
 * First Funder — where did this Base wallet's money originally come from?
 *
 * The first thing that ever touched a wallet is a strong provenance signal: an
 * agent vetting a counterparty wants to know if it was seeded from a known
 * exchange/bridge (real user) or from a fresh anon EOA (possible sybil/burner).
 * Reads the wallet's earliest transaction (all-history, via Covalent — CDP SQL
 * can't scan all-history without hitting its read cap) and resolves the funder:
 * who sent it, whether that funder is a contract (bridge/exchange/protocol) or an
 * EOA, and how old the wallet is. No other Base tool gives funding provenance in
 * one call. Not financial advice.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { walletFirstTx } from "./covalent";
import { finish } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

// Best-effort labels for well-known funding sources on Base. Conservative — an
// unlabeled funder is reported by address, never guessed. Extend as identified.
const KNOWN_FUNDERS: Record<string, string> = {
  "0x1682ae6375c4e4a97e4b583bc394c861a46d8962": "Circle CCTP TokenMessenger (cross-chain USDC)",
  "0x4200000000000000000000000000000000000010": "Base L2 Standard Bridge (from Ethereum L1)",
  "0x0000000000000000000000000000000000000000": "mint / bridge (0x0 — freshly issued or bridged in)",
};

export async function firstFunder(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || params.account || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a valid 0x... wallet address (wallet=)");
  const w = getAddress(wallet);

  const first = await walletFirstTx(w);
  if (!first.txHash) {
    return finish({
      wallet: w,
      verdict: "no_history",
      recommendation: "This address has no transaction history on Base — nothing to trace. It has never been funded or used here.",
      note: "Traces a Base wallet's funding provenance from its earliest transaction. wallet= required. Not financial advice.",
    });
  }

  // Read the earliest tx to find who funded it (the counterparty on the wallet's
  // very first onchain interaction — for a fresh account this is its funder).
  let funder: string | null = null;
  let toAddr: string | null = null;
  let valueWei = 0n;
  try {
    const tx = await client.getTransaction({ hash: first.txHash as `0x${string}` });
    funder = tx.from ? getAddress(tx.from) : null;
    toAddr = tx.to ? getAddress(tx.to) : null;
    valueWei = tx.value ?? 0n;
  } catch {
    // Fall back to what Covalent already gave us — still report first activity.
    return finish({
      wallet: w,
      verdict: "unresolved",
      firstActivity: first.firstAt,
      txCount: first.txCount,
      firstTx: first.txHash,
      recommendation: "Found the wallet's earliest transaction but couldn't read its details right now (RPC). Retry to resolve the funder.",
      note: "Traces a Base wallet's funding provenance from its earliest transaction. wallet= required. Not financial advice.",
    });
  }

  // If the earliest tx was SENT by the wallet, it already held funds before acting
  // (unusual for a fresh account) — the true funder predates its first outgoing tx.
  const walletActedFirst = funder?.toLowerCase() === w.toLowerCase();
  const realFunder = walletActedFirst ? toAddr : funder;

  let funderIsContract: boolean | null = null;
  if (realFunder) {
    try {
      const code = await client.getCode({ address: realFunder as `0x${string}` });
      funderIsContract = Boolean(code && code !== "0x");
    } catch {
      /* cosmetic — leave null */
    }
  }
  const label = realFunder ? KNOWN_FUNDERS[realFunder.toLowerCase()] ?? null : null;
  const ageDays = first.firstAt ? Math.floor((Date.now() - new Date(first.firstAt).getTime()) / 86400000) : null;

  const verdict = !realFunder
    ? "unresolved"
    : label
      ? "funded_known_source"
      : funderIsContract
        ? "funded_by_contract"
        : "funded_by_wallet";

  return finish({
    wallet: w,
    verdict, // funded_known_source | funded_by_contract | funded_by_wallet | unresolved | no_history
    firstFunder: realFunder,
    funderLabel: label,
    funderType: funderIsContract === null ? null : funderIsContract ? "contract" : "eoa",
    firstActivity: first.firstAt,
    walletAgeDays: ageDays,
    txCount: first.txCount,
    initialValueEth: valueWei > 0n ? (Number(valueWei) / 1e18).toFixed(6) : "0",
    firstTx: first.txHash,
    recommendation:
      verdict === "funded_known_source"
        ? `First funded ${ageDays ?? "?"}d ago from a recognized source: ${label}. That's a real on-ramp/bridge origin — a normal, lower-risk provenance.`
        : verdict === "funded_by_contract"
          ? `First funded ${ageDays ?? "?"}d ago by a CONTRACT (${realFunder}) — likely a bridge, exchange, or protocol. Check what that contract is before treating the origin as clean.`
          : verdict === "funded_by_wallet"
            ? `First funded ${ageDays ?? "?"}d ago by another EOA (${realFunder}), not a known exchange/bridge. A wallet-to-wallet seed — trace that funder if you're screening for sybil/burner clusters.${ageDays !== null && ageDays < 3 ? " ⚠️ Very new wallet." : ""}`
            : "Traced the earliest transaction but couldn't determine a clear funder.",
    note: "Traces a Base wallet's funding provenance: its earliest transaction, who first funded it (known exchange/bridge vs anon EOA vs contract), the initial value, and wallet age — the sybil/origin check no other Base tool gives in one call. wallet= required. Not financial advice.",
  });
}
