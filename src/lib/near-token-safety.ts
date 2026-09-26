/**
 * NEAR token safety — the NEAR-native counterpart of the B20 control checks:
 * before an agent takes a NEP-141 token, who can change the contract behind it?
 *
 * On NEAR a contract is code deployed to an account, and any FULL-ACCESS key on
 * that account can redeploy it — new code can rewrite balances, block transfers
 * or mint without limit. So the first question is not the token's metadata but
 * the account's keys:
 *
 *   - no contract deployed        → not a token at all (STOP)
 *   - no `ft_metadata`             → a contract, but not NEP-141 (STOP)
 *   - full-access keys present     → the code can be replaced by whoever holds
 *                                    them (HOLD — normal for many real tokens,
 *                                    but it is trust in a key, not in code)
 *   - no full-access keys          → "locked": code changes only through the
 *                                    contract's own methods (GO, with that caveat)
 *
 * Plus whether NEAR Intents routes the token (a liquidity signal) and its price
 * there. Reads only public, free sources — the NEAR RPC and 1Click's token list.
 */

import "server-only";

import {
  NEAR_ACCOUNT_RE,
  EMPTY_CODE_HASH,
  rpcQuery,
  viewCall,
  nearIntentsListing,
  formatUnits,
} from "./near-rpc";

export { NEAR_ACCOUNT_RE };

/**
 * No access key does not mean no one is in charge. A NEP-141 issuer usually
 * keeps power through the contract's own methods — an owner who can upgrade,
 * pause, blacklist or mint (Tether's USDt on NEAR has no keys at all, and is
 * still an issuer-controlled token). We cannot read the source, but the common
 * owner and pause views answer to a plain view call, so we ask for them.
 */
const OWNER_VIEWS = ["get_owner", "owner", "get_owner_id", "owner_id", "get_contract_owner", "contract_owner"];
const PAUSE_VIEWS = ["is_paused", "paused", "get_paused"];

/** First owner view that answers with an account id, and which method said so. */
async function findOwner(token: string): Promise<{ owner: string; method: string } | null> {
  const answers = await Promise.all(OWNER_VIEWS.map((m) => viewCall<unknown>(token, m).catch(() => null)));
  for (let i = 0; i < OWNER_VIEWS.length; i++) {
    const a = answers[i];
    const id =
      typeof a === "string"
        ? a
        : a && typeof a === "object"
          ? ((a as Record<string, unknown>).owner_id ?? (a as Record<string, unknown>).owner)
          : null;
    if (typeof id === "string" && NEAR_ACCOUNT_RE.test(id)) return { owner: id, method: OWNER_VIEWS[i] };
  }
  return null;
}

/** true/false from the first pause view that answers with a boolean; null when none does. */
export async function findPaused(token: string): Promise<{ paused: boolean; method: string } | null> {
  const answers = await Promise.all(PAUSE_VIEWS.map((m) => viewCall<unknown>(token, m).catch(() => null)));
  for (let i = 0; i < PAUSE_VIEWS.length; i++) {
    if (typeof answers[i] === "boolean") return { paused: answers[i] as boolean, method: PAUSE_VIEWS[i] };
  }
  return null;
}

type Verdict = "GO" | "HOLD" | "STOP";

export async function nearTokenSafety(params: Record<string, string>) {
  const token = (params.token || params.address || "").trim().toLowerCase();
  // A 0x address is almost always an EVM token pasted into the wrong check. NEAR
  // does have 0x "eth-implicit" accounts, but they hold wallets, not NEP-141s.
  if (/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error("That is an EVM address. For a Base token use token-risk or pre-trade-gate; this check takes a NEAR token account, e.g. usdt.tether-token.near");
  }
  if (!NEAR_ACCOUNT_RE.test(token)) {
    throw new Error("Provide a NEAR token contract account, e.g. usdt.tether-token.near or wrap.near");
  }
  const checkedAt = new Date().toISOString();
  const base = { chain: "near" as const, token, checkedAt };

  const account = await rpcQuery<{ amount: string; code_hash: string; storage_usage: number }>({
    request_type: "view_account",
    account_id: token,
  });
  if (!account.ok) {
    if (account.unknownAccount) {
      return { ...base, exists: false, verdict: "STOP" as Verdict, reasons: ["No such NEAR account — nothing to trade."] };
    }
    throw new Error(`NEAR RPC error (${account.message}) — not charged, retry shortly`);
  }

  const deployed = account.value.code_hash !== EMPTY_CODE_HASH;
  const accountInfo = {
    nearBalance: formatUnits(account.value.amount, 24),
    storageBytes: account.value.storage_usage,
    codeHash: deployed ? account.value.code_hash : null,
  };
  if (!deployed) {
    return {
      ...base,
      exists: true,
      account: accountInfo,
      verdict: "STOP" as Verdict,
      reasons: ["No contract is deployed on this account, so it is not a token."],
    };
  }

  const [keys, metadata, supply, listing, owner, pause] = await Promise.all([
    rpcQuery<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>({
      request_type: "view_access_key_list",
      account_id: token,
    }),
    viewCall<{ spec?: string; name?: string; symbol?: string; decimals?: number; icon?: string | null }>(token, "ft_metadata"),
    viewCall<string>(token, "ft_total_supply"),
    nearIntentsListing(token),
    findOwner(token),
    findPaused(token),
  ]);

  if (!metadata || typeof metadata.decimals !== "number") {
    return {
      ...base,
      exists: true,
      account: accountInfo,
      verdict: "STOP" as Verdict,
      reasons: ["A contract is deployed but it does not answer ft_metadata — not an NEP-141 fungible token."],
    };
  }

  const all = keys.ok ? keys.value.keys : [];
  const fullAccess = all.filter((k) => k.access_key.permission === "FullAccess").length;
  const functionCall = all.length - fullAccess;

  const reasons: string[] = [];
  let verdict: Verdict;
  if (pause?.paused) {
    verdict = "STOP";
    reasons.push(`Paused: ${pause.method}() returns true — transfers are halted by the contract right now.`);
  } else if (!keys.ok) {
    verdict = "HOLD";
    reasons.push("Could not read the account's access keys, so who can replace the contract is unknown.");
  } else if (fullAccess > 0) {
    verdict = "HOLD";
    reasons.push(
      `Upgradeable by key: ${fullAccess} full-access key${fullAccess === 1 ? "" : "s"} can redeploy this contract — new code could change balances, block transfers or mint. Common for real tokens; it means trusting whoever holds ${fullAccess === 1 ? "that key" : "those keys"}.`,
    );
  } else if (owner) {
    verdict = "HOLD";
    reasons.push(
      `Owner-controlled: no full-access key, but ${owner.method}() names an owner, ${owner.owner}. Owner-only methods commonly include upgrading the code, pausing, blacklisting holders or minting — normal for an issued asset (a stablecoin, say), but it is trust in that owner, not in fixed code.`,
    );
  } else {
    verdict = "GO";
    reasons.push(
      "Locked: no full-access key, and none of the common owner views answer. The code can only change through the contract's own methods; an admin function under an unusual name would not be seen, since this check does not read the contract's source.",
    );
  }
  if (pause && !pause.paused) reasons.push(`Not paused (${pause.method}() is false) — but a pause switch exists.`);
  if (listing?.listed) reasons.push("Routed by NEAR Intents — there is a swap path in and out.");
  else if (listing && !listing.listed) reasons.push("Not routed by NEAR Intents — liquidity may be thin or absent.");

  return {
    ...base,
    exists: true,
    account: accountInfo,
    metadata: { spec: metadata.spec ?? null, name: metadata.name ?? null, symbol: metadata.symbol ?? null, decimals: metadata.decimals },
    totalSupply: supply ? { raw: supply, formatted: formatUnits(supply, metadata.decimals) } : null,
    control: {
      fullAccessKeys: keys.ok ? fullAccess : null,
      functionCallKeys: keys.ok ? functionCall : null,
      upgradeableByKey: keys.ok ? fullAccess > 0 : null,
      owner: owner?.owner ?? null,
      ownerMethod: owner?.method ?? null,
      /** null = no common pause view answered; true/false = what it said. */
      paused: pause ? pause.paused : null,
    },
    market: { nearIntents: listing },
    verdict,
    reasons,
  };
}
