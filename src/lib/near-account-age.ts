/**
 * near-account-age — when was this NEAR account born, and who created it? The
 * provenance check NEAR's agent economy needs: before you trust, pay or copy a
 * NEAR account (or one of the 90+ agents bidding on NEAR AI's Agent Market), is
 * it an established account or a fresh throwaway created minutes ago?
 *
 * near-account describes the CURRENT state (balance, keys, storage); it does not
 * say how old the account is or where it came from. This reads that straight from
 * the NearBlocks indexer: the creation timestamp (age) and the creator of the
 * account (its first provenance hop), plus whether it has since been deleted.
 *
 * Age is a first-order Sybil / trust signal — new ≠ malicious, but a counterparty
 * created today deserves more caution than one that has existed for years. A
 * signal, not a verdict. Not financial advice.
 */

import "server-only";
import { nearblocks, nsToIso } from "./nearblocks";

const validId = (a: string) => /^[a-z0-9._-]{2,64}$/.test(a) || /^[0-9a-f]{64}$/.test(a);

interface AcctRow { account_id?: string; created?: { transaction_hash?: string; block_timestamp?: string | number }; deleted?: { transaction_hash?: string | null; block_timestamp?: string | number | null }; amount?: string }
interface TxRow { signer_account_id?: string; predecessor_account_id?: string }

// Creators that mean "made by a relayer/registrar/faucet", not a personal funder.
const SYSTEM_CREATOR = /^(near|register\.near|[a-z0-9_-]*relayer[a-z0-9_.-]*|[a-z0-9_-]*faucet[a-z0-9_.-]*)$/;

export async function nearAccountAge(params: Record<string, string>) {
  const account = (params.account || params.address || params.id || "").trim().toLowerCase();
  if (!validId(account)) throw new Error("Provide a NEAR account id (account=name.near or a 64-hex implicit id)");

  let acctResp: { account?: AcctRow[] };
  try {
    acctResp = await nearblocks<{ account?: AcctRow[] }>(`/account/${account}`);
  } catch (e) {
    throw e instanceof Error ? e : new Error("NEAR indexer error — not charged, retry shortly");
  }
  const a = acctResp.account?.[0];
  const createdTs = a?.created?.block_timestamp;
  const createdAt = nsToIso(createdTs);

  if (!a || !createdAt) {
    return {
      account,
      verdict: "not_created",
      note: "No creation record for this account — it may be an implicit account never funded (so it doesn't exist yet), a top-level account, or unknown to the indexer. Treat as unestablished, not safe. Not financial advice.",
      checkedAt: new Date().toISOString(),
    };
  }

  const ageDays = Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000);
  const deletedAt = nsToIso(a.deleted?.block_timestamp);
  const creationTx = a.created?.transaction_hash ?? null;

  // Best-effort: who created it (the creation tx's signer). Never fails the call.
  let creator: string | null = null;
  let creatorType: "system" | "account" | null = null;
  if (creationTx) {
    try {
      const txResp = await nearblocks<{ txns?: TxRow[] }>(`/txns/${creationTx}`);
      const signer = txResp.txns?.[0]?.signer_account_id ?? null;
      if (signer) { creator = signer; creatorType = SYSTEM_CREATOR.test(signer) ? "system" : "account"; }
    } catch { /* provenance is a bonus; age stands without it */ }
  }

  const verdict =
    deletedAt ? "deleted" : ageDays < 1 ? "brand_new" : ageDays < 7 ? "very_new" : ageDays < 30 ? "new" : ageDays < 365 ? "established" : "mature";

  return {
    account,
    createdAt,
    ageDays,
    creationTx,
    creator, // the account that created this one (its first provenance hop)
    creatorType, // system (relayer/registrar/faucet) | account
    deleted: Boolean(deletedAt),
    deletedAt,
    verdict, // deleted | brand_new | very_new | new | established | mature | not_created
    recommendation:
      deletedAt
        ? `⚠️ This account was DELETED (${deletedAt.slice(0, 10)}). Funds sent to a deleted named account fail or are lost — do not pay it.`
        : ageDays < 1
          ? `🛑 Created TODAY${creator ? ` by ${creator}` : ""} — a brand-new account. For a counterparty or an agent you're about to trust or pay, this is the highest-caution case: fresh accounts are the cheap raw material of Sybil/scam setups.`
          : ageDays < 7
            ? `⚠️ Only ${ageDays} day(s) old${creator ? ` (created by ${creator})` : ""}. Very new — fine for a throwaway, risky for anything you're trusting with size. Pair with near-wallet-activity to see if it has real history.`
            : ageDays < 30
              ? `${ageDays} days old${creator ? `, created by ${creator}` : ""}. New but past the first-week churn; still verify its activity before trusting it.`
              : `${ageDays} days old${creatorType === "account" && creator ? `, created by ${creator}` : ""} — an established${ageDays >= 365 ? "/mature" : ""} account (age is reassuring, not proof; check current activity and keys too).`,
    note: "Account creation date (age) and creator (first provenance hop) from the NearBlocks indexer, plus deletion status. Age is a Sybil/trust signal — new ≠ malicious, but a fresh counterparty warrants caution. Pair with near-account (state) and near-wallet-activity (history). Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
