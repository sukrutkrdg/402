/**
 * First Funder — where did this Base wallet's money originally come from?
 *
 * The first thing that ever touched a wallet is a strong provenance signal: an
 * agent vetting a counterparty wants to know if it was seeded from a known
 * exchange/bridge (real user) or from a fresh anon EOA (possible sybil/burner).
 * Reads the wallet's earliest transaction — searched out of the Base archive
 * itself, see ./wallet-history, after the Covalent feed this used to sit on was
 * cancelled — and resolves the funder: who sent it, whether that funder is a
 * contract (bridge/exchange/protocol) or an EOA, and how old the wallet is. No
 * other Base tool gives funding provenance in one call. Not financial advice.
 */

import "server-only";
import { createPublicClient, getAddress } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { walletFirstTx } from "./wallet-history";
import { finish } from "./envelope";
import { classifyCode } from "./primitives";

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
  // Two different nulls, and conflating them would be the dangerous answer. The
  // archive search sees an account through its balance and its nonce; a wallet
  // that only ever received tokens via internal transfers is invisible to both.
  // "We found nothing" is therefore not "there is nothing" — only an address
  // that is genuinely empty AND has never sent can be called untouched, and even
  // that we report as unresolved rather than clean.
  if (!first.resolved) {
    return finish({
      wallet: w,
      verdict: "no_history",
      recommendation:
        "This address holds no ETH and has never sent a transaction on Base, so there is no funding event to trace. " +
        "Token-only history received through internal transfers would not show up here — treat this as 'no funding found', not proof the address is unused.",
      note: "Traces a Base wallet's funding provenance from its earliest transaction. wallet= required. Not financial advice.",
    });
  }
  if (!first.txHash) {
    // The account exists and we know when it appeared, but nothing at the top
    // level of that block names it — a contract creation, an internal transfer,
    // or a token mint. Report the age we do know rather than inventing a funder.
    const ageOnly = first.firstAt ? Math.floor((Date.now() - new Date(first.firstAt).getTime()) / 86400000) : null;
    return finish({
      wallet: w,
      verdict: "unresolved",
      firstActivity: first.firstAt,
      walletAgeDays: ageOnly,
      recommendation: `First seen ${ageOnly ?? "?"}d ago, but the funding arrived through an internal transfer or contract call rather than a plain transaction, so no funder address is visible at the top level.`,
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
    // The search already established when the wallet appeared; report that much
    // rather than failing the whole call over one unreadable transaction.
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
      // Not `code !== "0x"`: a 7702-delegated wallet carries code and is still a
      // wallet. Calling every Base App smart wallet a contract funder changes
      // the provenance verdict for exactly the users most likely to have one.
      funderIsContract = classifyCode(code).isContract;
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
