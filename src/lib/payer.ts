/**
 * Which wallet paid for this request.
 *
 * x402 v2 renamed the payment header. A v1 client sends `X-PAYMENT`; a v2 client
 * sends `PAYMENT-SIGNATURE`, and every current client is v2 — our own challenges
 * advertise `x402Version: 2`. We only ever read `x-payment`, so from the day we
 * moved to v2 this returned "" for every real payment, and everything keyed on
 * the payer quietly stopped:
 *
 *   - `payersToday` on the dashboard read 0 while settlements were landing on
 *     chain, which we spent time reading as "no external buyers".
 *   - `usage:firstsvc` and `usage:payersvc` were never written, so no wallet
 *     could be shown what it had bought.
 *   - Worst: buy-credits could not index the balance against the paying wallet,
 *     so credit recovery was never armed. A buyer who lost their token had no
 *     way back to a balance they had paid for.
 *
 * The body is the same either way — base64 JSON — and the EIP-3009 payload
 * carries the payer at `payload.authorization.from`. The search stays structural
 * rather than reaching for that exact path, because the Permit2 variant of the
 * same scheme nests it differently and a missed payer is silent.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Depth-first search for the first address-shaped value under a payer-ish key. */
function dig(o: unknown, depth = 0): string {
  if (!o || typeof o !== "object" || depth > 6) return "";
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (/^(from|payer|sender|owner)$/i.test(k) && typeof v === "string" && ADDRESS.test(v)) return v;
    if (v && typeof v === "object") {
      const r = dig(v, depth + 1);
      if (r) return r;
    }
  }
  return "";
}

/**
 * The paying wallet, lowercased, or "" when it cannot be read.
 *
 * Never throws: this feeds analytics and the credit-recovery index, and neither
 * is worth failing a paid request over.
 */
export function payerFromHeaders(headers: { get(name: string): string | null }): string {
  // v2 first — it is what every current client sends — then the v1 name so an
  // older client keeps working.
  for (const name of ["payment-signature", "x-payment"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const json = Buffer.from(h, "base64").toString("utf8");
      const found = dig(JSON.parse(json));
      if (found) return found.toLowerCase();
    } catch {
      /* try the next header */
    }
  }
  return "";
}
