/**
 * NEAR transfer preflight — will this NEP-141 transfer go through? The NEAR
 * counterpart of b20-transfer-preflight.
 *
 * The failure NEAR is known for: a fungible-token contract only credits
 * accounts that have paid for their storage on it (`storage_deposit`). Send to
 * an unregistered receiver and the transfer fails — the wallet prompt "register
 * the receiving account" that every first-time sender meets. So before an agent
 * sends, this checks, in the order the chain would:
 *
 *   token   — exists, is NEP-141, is not paused
 *   to      — exists (or is an implicit id that transfers can create), and is
 *             registered on the token; if not, what the fix costs
 *   from    — (optional) registered, and holds at least `amount`
 *
 * STOP = will fail; HOLD = will fail until you do the named fix, or is a
 * likely mistake; GO = nothing found that would stop it.
 */

import "server-only";
import { NEAR_ACCOUNT_RE, EMPTY_CODE_HASH, rpcQuery, viewCall, formatUnits, parseUnits, accountKind } from "./near-rpc";
import { findPaused } from "./near-token-safety";

type Verdict = "GO" | "HOLD" | "STOP";
const rank: Record<Verdict, number> = { GO: 0, HOLD: 1, STOP: 2 };

function id(v: string | undefined, what: string, required: boolean): string | null {
  const s = (v || "").trim().toLowerCase();
  if (!s) {
    if (required) throw new Error(`${what} is required (a NEAR account, e.g. alice.near)`);
    return null;
  }
  if (/^0x[0-9a-f]{40}$/.test(s) && what === "token") {
    throw new Error("That is an EVM address. For a Base token use b20-transfer-preflight or token-risk; this check takes a NEAR token account, e.g. usdt.tether-token.near");
  }
  if (!NEAR_ACCOUNT_RE.test(s)) throw new Error(`${what} is not a NEAR account id`);
  return s;
}

export async function nearTransferPreflight(params: Record<string, string>) {
  const token = id(params.token, "token", true)!;
  const to = id(params.to, "to", true)!;
  const from = id(params.from, "from", false);
  const amountHuman = (params.amount || "").trim();
  const checkedAt = new Date().toISOString();

  const checks: { check: string; result: Verdict; detail: string }[] = [];
  let decimalsKnown: number | null = null;
  let balance: string | null = null; // declared up here: finish() can run before the sender section
  const add = (check: string, result: Verdict, detail: string) => checks.push({ check, result, detail });

  // ── token ──────────────────────────────────────────────────────────────
  const tAcct = await rpcQuery<{ code_hash: string }>({ request_type: "view_account", account_id: token });
  if (!tAcct.ok && !tAcct.unknownAccount) throw new Error(`NEAR RPC error (${tAcct.message}) — not charged, retry shortly`);
  const meta = tAcct.ok && tAcct.value.code_hash !== EMPTY_CODE_HASH
    ? await viewCall<{ symbol?: string; decimals?: number }>(token, "ft_metadata")
    : null;
  if (!meta || typeof meta.decimals !== "number") {
    add("token", "STOP", tAcct.ok ? `${token} is not a NEP-141 token (no ft_metadata).` : `${token} does not exist.`);
    return finish();
  }
  const decimals = meta.decimals;
  decimalsKnown = decimals;
  add("token", "GO", `${meta.symbol ?? token}, ${decimals} decimals.`);

  const [pause, toAcct, toStorage, bounds, fromStorage, fromBal] = await Promise.all([
    findPaused(token),
    rpcQuery<{ amount: string }>({ request_type: "view_account", account_id: to }),
    viewCall<{ total: string; available: string } | null>(token, "storage_balance_of", { account_id: to }),
    viewCall<{ min: string; max?: string | null }>(token, "storage_balance_bounds"),
    from ? viewCall<{ total: string } | null>(token, "storage_balance_of", { account_id: from }) : Promise.resolve(undefined),
    from ? viewCall<string>(token, "ft_balance_of", { account_id: from }) : Promise.resolve(undefined),
  ]);

  if (pause?.paused) add("paused", "STOP", `${pause.method}() is true — the contract has halted transfers.`);

  // ── receiver ───────────────────────────────────────────────────────────
  const kind = accountKind(to);
  if (!toAcct.ok) {
    if (!toAcct.unknownAccount) throw new Error(`NEAR RPC error (${toAcct.message}) — not charged, retry shortly`);
    if (kind === "implicit" || kind === "eth-implicit")
      add("to exists", "GO", "Implicit account not created yet — it comes into existence when funded; it still needs registering on the token (below).");
    else add("to exists", "STOP", `${to} does not exist; a transfer to it fails.`);
  } else {
    add("to exists", "GO", `${to} exists.`);
  }
  if (to === token) add("to", "HOLD", "The receiver is the token contract itself — tokens sent there are usually unrecoverable.");
  if (from && to === from) add("to", "HOLD", "Sender and receiver are the same account.");

  const deposit = bounds?.min ? formatUnits(bounds.min, 24) : null;
  if (toStorage === null) {
    // null answer: either unregistered, or the method is missing (non-standard token)
    add(
      "to registered",
      "HOLD",
      `${to} is not registered on ${token} — the transfer would fail. Fix: call storage_deposit({"account_id":"${to}","registration_only":true}) on ${token}` +
        (deposit ? `, attaching ${deposit} NEAR.` : ", attaching the storage deposit (storage_balance_bounds().min)."),
    );
  } else {
    add("to registered", "GO", `${to} is registered on ${token}.`);
  }

  // ── sender ─────────────────────────────────────────────────────────────
  if (from) {
    if (fromStorage === null) add("from registered", "STOP", `${from} is not registered on ${token}, so it holds none of it.`);
    balance = typeof fromBal === "string" && /^\d+$/.test(fromBal) ? fromBal : null;
    if (amountHuman) {
      const want = parseUnits(amountHuman, decimals);
      if (!want) throw new Error("amount must be a positive number in token units, e.g. 12.5");
      if (balance === null) add("balance", "HOLD", `Could not read ${from}'s balance.`);
      else if (BigInt(balance) < BigInt(want))
        add("balance", "STOP", `${from} holds ${formatUnits(balance, decimals)}, less than ${amountHuman}.`);
      else add("balance", "GO", `${from} holds ${formatUnits(balance, decimals)} — enough.`);
    }
  }

  return finish();

  function finish() {
    const verdict = checks.reduce<Verdict>((v, c) => (rank[c.result] > rank[v] ? c.result : v), "GO");
    return {
      chain: "near" as const,
      token,
      to,
      from,
      amount: amountHuman || null,
      checkedAt,
      verdict,
      checks,
      ...(balance !== null && from && decimalsKnown !== null ? { fromBalance: formatUnits(balance, decimalsKnown) } : {}),
      howToSend:
        'ft_transfer({"receiver_id": to, "amount": "<base units>"}) on the token contract, attaching exactly 1 yoctoNEAR; use ft_transfer_call when the receiver is a contract that must react.',
    };
  }
}
