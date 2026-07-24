/**
 * Address Trust — "is this counterparty a real, verified account or an anon/sybil?"
 *
 * The other half of an agent's pre-transaction check: spend-audit / sign-guard
 * answer "can this drain me?", this answers "who am I dealing with?". It reads
 * Coinbase's ONCHAIN verification (an EAS attestation issued by
 * verifications.coinbase.eth 0x3574…7EE) — meaning the address is tied to a
 * KYC'd Coinbase account, the strongest sybil-resistance signal on Base — plus
 * the address's Basename (soft identity). Identity is a trust signal, not proof
 * of honesty, but it raises the cost of being anonymous. Deterministic, no LLM.
 */

import "server-only";
import { getAddress } from "viem";
import { decisionReceipt } from "./envelope";
import { basenameResolve } from "./basename";

const EAS = "https://base.easscan.org/graphql";
const CB_ATTESTER = "0x357458739F90461b99789350868CD7CF330Dd7EE"; // verifications.coinbase.eth
const SCHEMA_VERIFIED_ACCOUNT = "0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9";

/** Query EAS on Base for a live (non-revoked, non-expired) Coinbase verification. */
async function coinbaseVerified(recipient: string): Promise<{ verified: boolean } | null> {
  const query = `query{attestations(take:1,where:{recipient:{equals:"${recipient}"},schemaId:{equals:"${SCHEMA_VERIFIED_ACCOUNT}"},attester:{equals:"${CB_ATTESTER}"},revoked:{equals:false}}){expirationTime decodedDataJson}}`;
  try {
    const r = await fetch(EAS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { attestations?: Array<{ expirationTime?: string | number; decodedDataJson?: string }> } };
    const rows = j?.data?.attestations ?? [];
    if (rows.length === 0) return { verified: false };
    const a = rows[0];
    const exp = Number(a.expirationTime || 0);
    const expired = exp !== 0 && exp < Math.floor(Date.now() / 1000);
    let value = false;
    try {
      const dec = JSON.parse(a.decodedDataJson || "[]") as Array<{ value?: { value?: unknown } }>;
      value = dec[0]?.value?.value === true;
    } catch {
      /* malformed → treat as unverified */
    }
    return { verified: value && !expired };
  } catch {
    return null;
  }
}

export async function addressTrust(params: Record<string, string>) {
  const raw = (params.address || params.wallet || params.account || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide an address (address=)");
  const addr = getAddress(raw);

  const [cbR, bnR] = await Promise.allSettled([coinbaseVerified(addr), basenameResolve({ address: addr })]);
  const cb = cbR.status === "fulfilled" ? cbR.value : null;
  const basename = bnR.status === "fulfilled" ? ((bnR.value as { name?: string | null })?.name ?? null) : null;

  const coinbaseVerifiedFlag = cb?.verified === true;
  const degraded = cb === null;

  const signals: string[] = [];
  if (coinbaseVerifiedFlag) signals.push("Coinbase-verified account (onchain attestation tied to a KYC'd Coinbase user)");
  if (basename) signals.push(`Basename: ${basename}`);
  if (degraded) signals.push("verification lookup degraded (EAS unavailable) — not confirmed either way");

  // Coinbase verification is the strong sybil-resistance signal; a basename is soft
  // identity. Neither proves honesty — they raise the cost of being anonymous.
  const verdict = degraded ? "unknown" : coinbaseVerifiedFlag ? "verified" : basename ? "named" : "anonymous";
  const trustScore = (coinbaseVerifiedFlag ? 70 : 0) + (basename ? 20 : 0);

  return {
    address: addr,
    coinbaseVerified: coinbaseVerifiedFlag,
    basename,
    verdict, // verified | named | anonymous | unknown
    trustScore, // 0–90 soft signal
    signals,
    receipt: {
      checked: addr,
      endpoint: "address-trust",
      decision: degraded ? "REFUSE" : coinbaseVerifiedFlag ? "GO" : "HOLD",
      ...decisionReceipt({
        endpoint: "address-trust",
        params: { address: addr },
        degraded,
        missing: degraded ? ["coinbase-verification-lookup (EAS)"] : [],
      }),
    },
    recommendation:
      degraded ? "Could not read Coinbase verification right now — do not treat as verified OR anonymous; re-check before trusting."
        : coinbaseVerifiedFlag ? "Tied to a KYC'd Coinbase account — the strongest onchain sybil-resistance signal. Still verify the specific transaction; identity ≠ intent."
          : basename ? "Has a Basename (soft identity) but no Coinbase verification — treat as pseudonymous; limit exposure."
            : "Anonymous — no Coinbase verification and no Basename. No sybil resistance; be cautious with funds and approvals.",
    note: "Reads Coinbase's onchain verification (EAS attestation by verifications.coinbase.eth) + Basename to gauge whether a counterparty is a real, KYC-linked account vs an anonymous/sybil address. A trust signal, not a guarantee of honesty. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
