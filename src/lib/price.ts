/**
 * Service price string ("$0.03") → integer cents (3).
 *
 * Rounds UP with a floor of one cent, because a cent is the smallest unit both
 * paid rails can charge and a sub-cent price would otherwise round to ZERO —
 * making the service free, permanently and silently. Prices below $0.01 (set to
 * compete on per-call rails where they are paid in USDC micro-units) therefore
 * cost 1¢ on a cent-denominated rail; each response reports what was actually
 * charged, so the difference is never hidden. Batch endpoints are the way to get
 * true sub-cent economics.
 *
 * This lives in its own module because it did not, once. Both paid rails carried
 * their own copy, the floor was added to the x402 one and not to the on-chain
 * one, and `Math.round(0.002 * 100)` is 0 — so every $0.002 service (11 of them,
 * including the whole primitives set) could be redeemed on the on-chain rail
 * with a payment of nothing. The guard is only worth having if there is one
 * copy of it.
 */
export function priceCents(price: string): number {
  const usd = parseFloat(price.replace(/[^0-9.]/g, "")) || 0;
  if (usd <= 0) return 0;
  return Math.max(1, Math.ceil(usd * 100));
}
