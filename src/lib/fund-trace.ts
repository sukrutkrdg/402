/**
 * Fund trace — source of funds, multiple hops back, with sanctions taint.
 *
 * first-funder answers "who funded this wallet" one hop. Compliance and
 * agent-safety need the next question: trace that funder's funder, and so on,
 * until the money reaches a recognisable origin — a CEX/bridge (a real, KYC'd
 * on-ramp) — or until it touches a SANCTIONED address (taint by provenance, the
 * money is dirty), or until it dead-ends in a chain of fresh anon EOAs (the
 * sybil/burner cluster shape). One call, a bounded walk, a verdict an agent can
 * refuse on.
 *
 * Honest limits, carried in the response: the Base archive search sees a wallet
 * through its balance and nonce, so funding that arrived only via internal
 * transfers is invisible and the trace stops as "unresolved" there — never
 * guessed. Each hop is best-effort; a hop we cannot read ends the walk rather
 * than inventing a link.
 */

import "server-only";
import { createPublicClient, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { walletFirstTx } from "./wallet-history";
import { classifyCode } from "./primitives";
import { sanctionsCheck } from "./compliance";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KNOWN_FUNDERS: Record<string, string> = {
  "0x1682ae6375c4e4a97e4b583bc394c861a46d8962": "Circle CCTP TokenMessenger (cross-chain USDC)",
  "0x4200000000000000000000000000000000000010": "Base L2 Standard Bridge (from Ethereum L1)",
  "0x0000000000000000000000000000000000000000": "mint / bridge (0x0)",
};

type FunderKind = "known_source" | "contract" | "eoa" | "unresolved";
interface Resolved { funder: string | null; kind: FunderKind; label: string | null; ageDays: number | null }

/** One hop: who first funded `w`, and what kind of thing it is. */
async function resolveFunder(w: Address): Promise<Resolved> {
  let first: Awaited<ReturnType<typeof walletFirstTx>>;
  try {
    first = await walletFirstTx(w); // heavy archive search — a rate-limited hop must END the walk, not 502 the paid call
  } catch {
    return { funder: null, kind: "unresolved", label: null, ageDays: null };
  }
  if (!first.resolved || !first.txHash) return { funder: null, kind: "unresolved", label: null, ageDays: null };
  let funder: string | null = null, toAddr: string | null = null;
  try {
    const tx = await client.getTransaction({ hash: first.txHash as `0x${string}` });
    funder = tx.from ? getAddress(tx.from) : null;
    toAddr = tx.to ? getAddress(tx.to) : null;
  } catch {
    return { funder: null, kind: "unresolved", label: null, ageDays: null };
  }
  const real = funder?.toLowerCase() === w.toLowerCase() ? toAddr : funder; // wallet acted first → funder predates
  const ageDays = first.firstAt ? Math.floor((Date.now() - new Date(first.firstAt).getTime()) / 86400000) : null;
  if (!real) return { funder: null, kind: "unresolved", label: null, ageDays };
  const label = KNOWN_FUNDERS[real.toLowerCase()] ?? null;
  if (label) return { funder: real, kind: "known_source", label, ageDays };
  let isContract = false;
  try { isContract = classifyCode(await client.getCode({ address: real as Address })).isContract; } catch { /* treat as eoa */ }
  return { funder: real, kind: isContract ? "contract" : "eoa", label: null, ageDays };
}

async function isSanctioned(addr: string): Promise<boolean> {
  try { return Boolean((await sanctionsCheck({ address: addr })).sanctioned); } catch { return false; }
}

export async function fundTrace(params: Record<string, string>) {
  const wallet = (params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("Provide a wallet address (wallet=0x…)");
  const maxHops = Math.min(Math.max(Number(params.hops ?? params.maxHops) || 5, 1), 8);

  const hops: Array<Record<string, unknown>> = [];
  const seen = new Set<string>([wallet.toLowerCase()]);
  let current = getAddress(wallet) as Address;
  let verdict: "tainted" | "reached_known_source" | "anon_cluster" | "unresolved" = "unresolved";
  let origin: string | null = null;

  for (let i = 0; i < maxHops; i++) {
    // Each hop's earliest-tx lookup fires a burst of archive reads; space the hops
    // out so the per-second RPC limit resets between them (one hop is fine — it is
    // first-funder — but back-to-back hops otherwise trip a public-RPC rate cap).
    if (i > 0) await sleep(1500);
    const sanctionedNow = i === 0 ? await isSanctioned(current) : false; // hop-0 checked once at start
    if (sanctionedNow) { verdict = "tainted"; origin = current; hops.push({ hop: i, address: current, kind: "sanctioned" }); break; }

    const r = await resolveFunder(current);
    const tainted = r.funder ? await isSanctioned(r.funder) : false;
    hops.push({ hop: i + 1, from: current, funder: r.funder, kind: tainted ? "sanctioned" : r.kind, label: r.label, ageDays: r.ageDays });

    if (tainted) { verdict = "tainted"; origin = r.funder; break; }
    if (r.kind === "unresolved") { verdict = i === 0 ? "unresolved" : "anon_cluster"; break; }
    if (r.kind === "known_source" || r.kind === "contract") { verdict = "reached_known_source"; origin = r.funder; break; }
    // eoa → keep walking up, unless we loop
    if (!r.funder || seen.has(r.funder.toLowerCase())) { verdict = "anon_cluster"; break; }
    seen.add(r.funder.toLowerCase());
    current = r.funder as Address;
    if (i === maxHops - 1) verdict = "anon_cluster"; // ran out of hops still in anon EOAs
  }

  const depth = hops.length;
  return {
    wallet: getAddress(wallet),
    hopsTraced: depth,
    maxHops,
    verdict, // tainted | reached_known_source | anon_cluster | unresolved
    origin, // the terminal address the funds trace to (CEX/bridge, or sanctioned)
    trace: hops,
    recommendation:
      verdict === "tainted"
        ? `⚠️ TAINTED PROVENANCE — the funding chain touches an OFAC-sanctioned address (${origin}). Treat these funds as dirty; do not accept or mix without compliance review.`
        : verdict === "reached_known_source"
          ? `Funds trace back to a recognisable on-ramp (${origin}) in ${depth} hop(s) — a real exchange/bridge origin, the lower-risk provenance. (Not proof of identity; a CEX hot wallet funds many users.)`
          : verdict === "anon_cluster"
            ? `Funding stays in a chain of unlabelled EOAs across ${depth} hop(s) without reaching a known on-ramp — the sybil/burner-cluster shape. Higher sybil risk; size and trust accordingly.`
            : "Could not trace funding — the wallet's origin is invisible to the archive (internal-transfer or token-only funding). 'Unresolved', not clean.",
    note: "Traces a Base wallet's source of funds across multiple hops to a known on-ramp or a sanctioned address, flagging taint by provenance. Best-effort: funding via internal transfers is invisible and ends the walk; each hop is the wallet's earliest funder. A CEX origin is a lower-risk signal, not identity. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
