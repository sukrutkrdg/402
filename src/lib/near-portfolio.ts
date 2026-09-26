/**
 * NEAR portfolio — what a NEAR account holds and what it is worth. The NEAR
 * counterpart of wallet-networth.
 *
 * NEAR has no "list my tokens" call: a balance lives inside each token's own
 * contract. So the scan asks every NEP-141 that NEAR Intents routes (the
 * tokens with a live price, which is what a value needs) for this account's
 * balance, plus the account's own NEAR — liquid and staked — valued at wNEAR.
 * A token outside that list is not scanned, and the response says so.
 */

import "server-only";
import { NEAR_ACCOUNT_RE, rpcQuery, viewCall, intentsTokens, formatUnits, accountKind } from "./near-rpc";

const MAX_TOKENS = 60;
const CONCURRENCY = 8;

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const usd = (n: number) => +n.toFixed(2);

export async function nearPortfolio(params: Record<string, string>) {
  const id = (params.account || params.address || "").trim().toLowerCase();
  if (!NEAR_ACCOUNT_RE.test(id)) throw new Error("Provide a NEAR account, e.g. alice.near or a 64-hex implicit account");
  const checkedAt = new Date().toISOString();

  const acct = await rpcQuery<{ amount: string; locked: string }>({ request_type: "view_account", account_id: id });
  if (!acct.ok) {
    if (acct.unknownAccount) return { chain: "near" as const, account: id, kind: accountKind(id), exists: false, checkedAt, totalUsd: 0, holdings: [] };
    throw new Error(`NEAR RPC error (${acct.message}) — not charged, retry shortly`);
  }
  const tokens = await intentsTokens();
  if (!tokens) throw new Error("NEAR Intents token list unavailable (prices) — not charged, retry shortly");

  const nearPrice = tokens.find((t) => t.assetId === "nep141:wrap.near")?.price ?? null;
  const seen = new Set<string>();
  const scan = tokens
    .filter((t) => t.blockchain === "near" && t.contractAddress && typeof t.price === "number" && t.price > 0)
    .filter((t) => (seen.has(t.contractAddress!) ? false : (seen.add(t.contractAddress!), true)))
    .slice(0, MAX_TOKENS);

  let unreadable = 0;
  const balances = await mapLimited(scan, CONCURRENCY, async (t) => {
    try {
      const raw = await viewCall<string>(t.contractAddress!, "ft_balance_of", { account_id: id });
      return typeof raw === "string" && /^\d+$/.test(raw) ? raw : null;
    } catch {
      unreadable++;
      return null;
    }
  });

  const holdings = scan
    .map((t, i) => ({ t, raw: balances[i] }))
    .filter((x): x is { t: (typeof scan)[number]; raw: string } => x.raw !== null && x.raw !== "0")
    .map(({ t, raw }) => {
      const amount = formatUnits(raw, t.decimals);
      return {
        symbol: t.symbol,
        contract: t.contractAddress!,
        balance: amount,
        priceUsd: t.price!,
        valueUsd: usd(Number(amount) * t.price!),
      };
    });

  const liquid = Number(formatUnits(acct.value.amount, 24));
  const staked = Number(formatUnits(acct.value.locked, 24));
  const native = {
    liquidNear: formatUnits(acct.value.amount, 24),
    stakedNear: formatUnits(acct.value.locked, 24),
    priceUsd: nearPrice,
    valueUsd: nearPrice ? usd((liquid + staked) * nearPrice) : null,
  };
  holdings.sort((a, b) => b.valueUsd - a.valueUsd);
  const tokensUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);

  return {
    chain: "near" as const,
    account: id,
    kind: accountKind(id),
    exists: true,
    checkedAt,
    totalUsd: usd(tokensUsd + (native.valueUsd ?? 0)),
    near: native,
    holdings,
    coverage: {
      tokensScanned: scan.length,
      unreadable,
      note: "Scans the NEP-141 tokens NEAR Intents routes with a live price; other tokens the account may hold are not included. Balances held inside NEAR Intents itself are not included either.",
    },
  };
}
