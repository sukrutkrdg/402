/**
 * NEAR token holders — who holds a NEP-141 token, and how concentrated is it?
 * The number a trader checks before buying: if one or a few accounts hold
 * most of the supply, they can move the price at will.
 *
 * Supply and metadata come from the token contract (RPC); the holder list
 * from the NearBlocks indexer, since no contract can list its own holders.
 * Each top holder is labelled — the token itself, a contract (pools, bridges,
 * NEAR Intents: one account holding for many users), or a plain account —
 * because a pool holding 40% is not a whale holding 40%. Concentration is
 * measured over plain accounts only, and over everything.
 */

import "server-only";
import { NEAR_ACCOUNT_RE, EMPTY_CODE_HASH, rpcQuery, viewCall, formatUnits, accountKind } from "./near-rpc";
import { nearblocks, toBigInt } from "./nearblocks";

const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : null);

export async function nearTokenHolders(params: Record<string, string>) {
  const token = (params.token || "").trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error("That is an EVM address. For a Base token use holders or holder-forensics; this check takes a NEAR token account, e.g. usdt.tether-token.near");
  }
  if (!NEAR_ACCOUNT_RE.test(token)) throw new Error("token is required: a NEAR token contract account, e.g. usdt.tether-token.near");
  const n = params.top ? Number(params.top) : 10;
  if (!Number.isInteger(n) || n < 1 || n > 25) throw new Error("top is how many holders to list: 1–25 (default 10)");
  const checkedAt = new Date().toISOString();

  const [meta, supplyRaw] = await Promise.all([
    viewCall<{ name?: string; symbol?: string; decimals?: number }>(token, "ft_metadata"),
    viewCall<string>(token, "ft_total_supply"),
  ]);
  if (!meta || typeof meta.decimals !== "number") {
    const acct = await rpcQuery<{ code_hash: string }>({ request_type: "view_account", account_id: token });
    if (!acct.ok && !acct.unknownAccount) throw new Error(`NEAR RPC error (${acct.message}) — not charged, retry shortly`);
    throw new Error(acct.ok ? `${token} is not a NEP-141 token (no ft_metadata)` : `${token} does not exist on NEAR`);
  }
  const decimals = meta.decimals;
  const supply = typeof supplyRaw === "string" && /^\d+$/.test(supplyRaw) ? BigInt(supplyRaw) : null;

  const enc = encodeURIComponent(token);
  const [list, cnt] = await Promise.all([
    nearblocks<{ holders?: { account: string; amount: string | number }[] }>(`/v1/fts/${enc}/holders?per_page=25&order=desc`),
    nearblocks<{ holders?: { count?: string | number }[] }>(`/v1/fts/${enc}/holders/count`).catch(() => null),
  ]);
  const raw = (Array.isArray(list.holders) ? list.holders : [])
    .map((h) => ({ account: String(h.account), amount: toBigInt(h.amount) }))
    .filter((h): h is { account: string; amount: bigint } => h.amount !== null && h.amount > 0n);
  const holderCount = cnt?.holders?.[0]?.count !== undefined ? Number(cnt.holders[0].count) : null;

  // Which of the top holders are contracts: one view_account each.
  const codes = await Promise.all(
    raw.map(async (h) => {
      const a = await rpcQuery<{ code_hash: string }>({ request_type: "view_account", account_id: h.account });
      return a.ok ? a.value.code_hash !== EMPTY_CODE_HASH : null;
    }),
  );
  const labelled = raw.map((h, i) => ({
    ...h,
    type:
      h.account === token
        ? ("token-contract" as const)
        : codes[i]
          ? ("contract" as const)
          : ("account" as const),
  }));

  const sum = (xs: { amount: bigint }[]) => xs.reduce((s, h) => s + h.amount, 0n);
  const whole = supply ?? sum(labelled);
  const plain = labelled.filter((h) => h.type === "account");
  const top1 = pct(labelled[0]?.amount ?? 0n, whole);
  const top10 = pct(sum(labelled.slice(0, 10)), whole);
  const plainTop1 = pct(plain[0]?.amount ?? 0n, whole);
  const plainTop10 = pct(sum(plain.slice(0, 10)), whole);

  const signals: string[] = [];
  let concentration: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  if (plainTop1 !== null && plainTop1 > 50) {
    concentration = "HIGH";
    signals.push(`One plain account, ${plain[0].account}, holds ${plainTop1}% of the supply — it alone can move the price.`);
  } else if (plainTop10 !== null && plainTop10 > 80) {
    concentration = "HIGH";
    signals.push(`The top plain accounts hold ${plainTop10}% of the supply.`);
  } else if ((plainTop1 !== null && plainTop1 > 20) || (plainTop10 !== null && plainTop10 > 50)) {
    concentration = "MEDIUM";
    signals.push(`Top plain account ${plainTop1}%, top 10 plain accounts ${plainTop10}% of the supply.`);
  }
  const selfHeld = labelled.find((h) => h.type === "token-contract");
  if (selfHeld) signals.push(`The token contract itself holds ${pct(selfHeld.amount, whole)}% — unissued or treasury supply.`);
  if (top1 !== null && plainTop1 !== null && top1 > plainTop1 + 20)
    signals.push(`The largest holder is a contract (${labelled[0].account}) — a pool, bridge or custodian holding for many users, not one owner.`);
  if (holderCount !== null && holderCount < 50) signals.push(`Only ${holderCount} holders.`);
  if (!labelled.length) signals.push("The indexer lists no holders — a new or unused token.");
  if (supply === null) signals.push("ft_total_supply did not answer; shares are of the listed holders, not the supply.");

  return {
    chain: "near" as const,
    token,
    name: meta.name ?? null,
    symbol: meta.symbol ?? null,
    decimals,
    checkedAt,
    totalSupply: supply !== null ? formatUnits(supply.toString(), decimals) : null,
    holderCount,
    concentration,
    shares: { top1Pct: top1, top10Pct: top10, top1AccountPct: plainTop1, top10AccountsPct: plainTop10 },
    signals,
    holders: labelled.slice(0, n).map((h, i) => ({
      rank: i + 1,
      account: h.account,
      type: h.type,
      kind: accountKind(h.account),
      balance: formatUnits(h.amount.toString(), decimals),
      sharePct: pct(h.amount, whole),
    })),
    source: "supply from the token contract (NEAR RPC); holders from the NearBlocks indexer",
  };
}
