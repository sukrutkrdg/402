/**
 * Put the payment terms in the 402 body as well as the header.
 *
 * `withX402` v2 answers a challenge with the terms base64'd into
 * `payment-required` and an otherwise bare JSON body. That is spec-correct, and
 * it is what the best-performing operator on this rail does — `stableenrich.dev`
 * returns a completely empty 402 body and draws 232 unique payers a month — so
 * this is emphatically NOT the reason anyone walks away from us, and it must not
 * be sold as a demand fix. The demand question was measured separately and the
 * answer was the brand name in the resource path.
 *
 * What it is, is free compatibility. A client written against the earlier
 * convention reads `accepts` out of the JSON body. Ours carries a response
 * sample and no price, so such a client sees goods it cannot price and gives up
 * without ever sending a request that would appear in our logs — a silent loss,
 * which is the only kind we cannot measure. One decode serves both generations.
 *
 * Reported by Cairn (cairn@cairnwake.com) on 2026-09-04 and verified here before
 * acting: our body carried neither `accepts` nor `x402Version`, while Tavily's
 * carries the version and Exa's carries both.
 */

/**
 * Merge the decoded `payment-required` terms into a challenge body.
 *
 * Existing keys always win. If the library ever starts populating the body
 * itself, its version is the authoritative one and this becomes a no-op rather
 * than a second source of truth — the same rule the price rails follow.
 *
 * Returns the same object it was given, so a caller can keep enriching it.
 * Never throws: a header we cannot read is the library's to own, and an
 * unreadable one must not cost the caller the challenge itself.
 */
export function withPaymentTerms(
  body: Record<string, unknown>,
  headers: Headers,
): Record<string, unknown> {
  try {
    // Both spellings, for the same reason the route rewrites both.
    const raw = headers.get("payment-required") ?? headers.get("x-payment-required");
    if (!raw) return body;
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return body;
    for (const [k, v] of Object.entries(decoded as Record<string, unknown>)) {
      if (body[k] === undefined) body[k] = v;
    }
  } catch {
    /* undecodable header — leave the body exactly as it was */
  }
  return body;
}
