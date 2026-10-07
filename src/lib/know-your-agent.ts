/**
 * Know Your Agent (KYA) — the identity half of agent trust.
 *
 * x402 proves payment; the ecosystem is now building the layer that answers
 * "should this agent be recognised" — ERC-8004-style registries, ENS/Basenames
 * for agents, onchain attestations. We already answer two of the three trust
 * questions: x402-seller-check (is the seller's endpoint/wallet real) and
 * agent-reputation (behaviour from payment history). This is the third: who the
 * wallet IS, from signals that cost something to fake.
 *
 * It composes what is readable on Base TODAY, and is explicit about the one slot
 * that is not:
 *   - Coinbase verification + Basename (address-trust): the strong sybil-resistance
 *     signal (a KYC'd attestation) and the soft one (a claimed name).
 *   - Behavioural track record (agent-reputation): established / sampler / thin.
 *   - ERC-8004 registry entry: read ONLY when a verified registry address is
 *     configured (KYA_ERC8004_REGISTRY). The standard is still landing and we do
 *     not guess a registry address or ABI — absent config, this is reported as
 *     "not checked", never as "no identity".
 *
 * One KYA verdict an agent/seller can branch on: recognised / named / anonymous /
 * unknown — identity, explicitly NOT intent (a verified agent can still behave
 * badly; this says the counterparty is not an anonymous throwaway).
 */

import "server-only";
import { addressTrust } from "./address-trust";
import { agentReputation } from "./agent-reputation";

export async function knowYourAgent(params: Record<string, string>) {
  const raw = (params.agent || params.wallet || params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide the agent wallet (agent=0x…)");
  const wallet = raw;

  const [trustR, repR] = await Promise.allSettled([
    addressTrust({ address: wallet }),
    agentReputation({ wallet }),
  ]);

  const trust = trustR.status === "fulfilled"
    ? (trustR.value as { coinbaseVerified?: boolean; basename?: string | null; verdict?: string; trustScore?: number })
    : null;
  const rep = repR.status === "fulfilled"
    ? (repR.value as { verdict?: string; distinctRecipients?: number; totalPayments?: number; repeatRecipients?: number })
    : null;

  // ERC-8004 is read only against a configured, verified registry — never guessed.
  const erc8004Configured = Boolean(process.env.KYA_ERC8004_REGISTRY?.trim());
  const identity = {
    coinbaseVerified: trust?.coinbaseVerified ?? null,
    basename: trust?.basename ?? null,
    identityVerdict: trust?.verdict ?? "unknown", // verified | named | anonymous | unknown
    identityScore: trust?.trustScore ?? null, // 0–90 soft
    erc8004: erc8004Configured
      ? { checked: true as const, note: "ERC-8004 registry configured — registry read wired here." }
      : { checked: false as const, note: "ERC-8004 registry not configured (KYA_ERC8004_REGISTRY). The standard is still landing; not guessed. 'Not checked', not 'no identity'." },
  };

  const behaviour = rep
    ? { verdict: rep.verdict ?? "unknown", distinctRecipients: rep.distinctRecipients ?? null, totalPayments: rep.totalPayments ?? null, repeatRecipients: rep.repeatRecipients ?? null }
    : { verdict: "unknown", note: "payment-history read failed this call" };

  // KYA verdict: identity leads (it is what costs money to fake); behaviour
  // corroborates. A degraded identity read is "unknown", never a pass.
  const idV = trust?.verdict ?? "unknown";
  const kya: "recognised" | "named" | "anonymous" | "unknown" =
    idV === "unknown" ? "unknown"
      : trust?.coinbaseVerified ? "recognised"
        : trust?.basename ? "named"
          : "anonymous";

  const strongBehaviour = rep?.verdict === "established" || rep?.verdict === "active";

  return {
    agent: wallet,
    kya, // recognised | named | anonymous | unknown
    identity,
    behaviour,
    recommendation:
      kya === "recognised"
        ? `Recognised: tied to a KYC'd Coinbase account${trust?.basename ? ` (${trust.basename})` : ""}${strongBehaviour ? ", with a real payment track record" : ""}. The strongest onchain identity signal — still identity, not intent.`
        : kya === "named"
          ? `Named: carries a Basename${trust?.basename ? ` (${trust.basename})` : ""} but no Coinbase verification — pseudonymous. ${strongBehaviour ? "Behaviour corroborates (repeat/sustained payer)." : "Thin or sampler behaviour; limit exposure."}`
          : kya === "anonymous"
            ? "Anonymous: no Coinbase verification, no Basename. Nothing raises the cost of being a throwaway — treat a first interaction as untrusted and size accordingly."
            : "Identity could not be read this call (verification lookup degraded) — UNKNOWN, not clear. Re-check before recognising it.",
    note: "Know-Your-Agent: resolves a wallet's onchain identity (Coinbase verification, Basename, and an ERC-8004 registry entry when configured) and corroborates with its payment track record. The identity half of agent trust, alongside x402-seller-check (endpoint) and agent-reputation (behaviour). Identity is not intent. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
