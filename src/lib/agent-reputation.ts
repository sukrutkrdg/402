/**
 * Agent reputation — the payer-trust mirror of x402-seller-check.
 *
 * A seller deciding whether to serve an agent, or one agent sizing up another,
 * has the same blind spot the buyer side does: x402 proves a payment settled, not
 * that the wallet behind it is a real, repeat participant versus a one-shot
 * sampler or a fresh burner. This reads a wallet's OUTGOING USDC history on Base
 * and turns it into a behavioural read:
 *
 *   - distinct recipients it has paid (breadth)
 *   - total payments and total USDC (depth)
 *   - repeat recipients (did it ever come back to the same payee)
 *
 * The signal this is built around is measured, not guessed: on 2026-09-19 one
 * wallet paid thirteen of our services in twenty-seven minutes and turned out to
 * be sampling 25+ x402 sellers — breadth without depth is a crawler, not a
 * customer. A wallet that pays the SAME payee repeatedly, or sustains payments
 * over time, is the opposite. The verdict names which pattern it sees.
 *
 * Honest limits, stated in the response: this sees only public USDC transfers on
 * Base (the x402 settlement asset), not other tokens or chains, and a wallet that
 * routes through a fresh address each time will read as new — absence of history
 * is reported as "thin", never as "bad".
 */

import "server-only";
import { cdpSql } from "./covalent";
import { USDC_BASE } from "./config";

const WINDOW_DAYS = 90;

export async function agentReputation(params: Record<string, string>) {
  const raw = (params.wallet || params.address || params.payer || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide the agent/payer wallet (wallet=0x…)");
  const wallet = raw.toLowerCase();

  const rows = await cdpSql<{ to?: string; v?: string; t?: string }>(
    `SELECT lower(toString(parameters['to'])) AS to, toString(parameters['value']) AS v, block_timestamp AS t
     FROM base.events
     WHERE address = '${USDC_BASE.toLowerCase()}'
       AND event_signature = 'Transfer(address,address,uint256)'
       AND lower(toString(parameters['from'])) = '${wallet}'
       AND block_timestamp > now() - INTERVAL ${WINDOW_DAYS} DAY
     LIMIT 2000`,
  );
  // A failed warehouse read is "unknown", never "no history" — the same discipline
  // repeat-buyers keeps. Saying a wallet is new because the query failed is the
  // false-negative that would let a burner pass as thin-but-fine.
  if (rows === null) {
    return {
      wallet: raw,
      degraded: true,
      verdict: "unknown",
      note: "⚠️ Could not read the chain warehouse this call — this wallet's payment history is UNKNOWN, not empty. Re-check before trusting it.",
      checkedAt: new Date().toISOString(),
    };
  }

  const byRecipient = new Map<string, { payments: number; usdc: number }>();
  let totalUsdc = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const r of rows) {
    const to = String(r.to ?? "");
    if (!/^0x[0-9a-f]{40}$/.test(to)) continue;
    let usd = 0;
    try { usd = Number(BigInt(r.v || "0")) / 1e6; } catch { usd = 0; }
    const prev = byRecipient.get(to) ?? { payments: 0, usdc: 0 };
    byRecipient.set(to, { payments: prev.payments + 1, usdc: +(prev.usdc + usd).toFixed(4) });
    totalUsdc += usd;
    const t = r.t ?? null;
    if (t) { if (!firstTs || t < firstTs) firstTs = t; if (!lastTs || t > lastTs) lastTs = t; }
  }

  const distinctRecipients = byRecipient.size;
  const totalPayments = rows.length;
  const repeatRecipients = [...byRecipient.values()].filter((v) => v.payments > 1).length;
  const spanDays = firstTs && lastTs ? Math.max(0, Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 86_400_000)) : 0;

  // Behavioural verdict. Depth (repeat payees, or payments sustained over days)
  // is the customer signal; breadth with no depth is the sampler/crawler pattern.
  let verdict: "established" | "active" | "sampler" | "thin";
  if (totalPayments === 0) verdict = "thin";
  else if (repeatRecipients >= 1 || spanDays >= 7) verdict = totalPayments >= 10 ? "established" : "active";
  else if (distinctRecipients >= 5 && repeatRecipients === 0 && spanDays <= 1) verdict = "sampler";
  else verdict = "thin";

  const topRecipients = [...byRecipient.entries()]
    .sort((a, b) => b[1].payments - a[1].payments)
    .slice(0, 5)
    .map(([to, agg]) => ({ to, payments: agg.payments, usdc: agg.usdc }));

  return {
    wallet: raw,
    windowDays: WINDOW_DAYS,
    totalPayments,
    distinctRecipients,
    repeatRecipients,
    totalUsdc: +totalUsdc.toFixed(4),
    activeSpanDays: spanDays,
    firstPaymentAt: firstTs,
    lastPaymentAt: lastTs,
    topRecipients,
    verdict, // established | active | sampler | thin | unknown
    recommendation:
      verdict === "established"
        ? "A sustained repeat payer across multiple sellers — behaves like a real customer, not a crawler."
        : verdict === "active"
          ? "Some depth (a repeat payee or payments over several days) — a plausible customer, not just a one-shot."
          : verdict === "sampler"
            ? "Breadth without depth: many distinct sellers paid once in a short burst. This is the crawler/sampler pattern, not demand. Treat a single payment from it as a probe."
            : "Thin on-chain USDC history on Base in this window. Not a red flag on its own — a new or single-use wallet looks identical — but there is little to vouch for it.",
    note: `Behavioural reputation from a wallet's OUTGOING USDC payments on Base over ${WINDOW_DAYS} days (the x402 settlement asset). Sees only Base USDC, not other tokens or chains; absence of history reads as 'thin', never as bad. The payer-trust mirror of x402-seller-check. Not financial advice.`,
    checkedAt: new Date().toISOString(),
  };
}
