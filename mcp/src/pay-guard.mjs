/**
 * Wallet-mode payment guard.
 *
 * The paying fetch signs whatever a 402 asks for. The tools come from a catalog
 * fetched over the network (or from X402_BAZAAR_CATALOG), so an endpoint on
 * another host — or a 402 naming another payee — would otherwise receive a
 * signed USDC authorization from the agent's key. Reported, with a reproduction,
 * in sukrutkrdg/x402-bazaar-mcp#8.
 *
 * Before anything is signed:
 *   - the request must go to PAY_ORIGIN (the origin the client contacts, not the
 *     402's own resource.url, which the server chooses);
 *   - the requirement must pay PAY_TO, in USDC on Base mainnet, at or under
 *     MAX_PRICE_USD.
 * All three are constants here, overridable only by explicit env vars — never
 * read from the catalog or from the 402.
 */

export const PAY_ORIGIN = (process.env.X402_PAY_ORIGIN || "https://402.com.tr").replace(/\/+$/, "");
export const PAY_TO = (process.env.X402_PAY_TO || "0x973a31858f4d2125f48c880542da11a2796f12d6").toLowerCase();
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_NETWORK = "eip155:8453";
// Covers every service including the $0.75 dossiers; buy_credits packs above it
// need X402_MAX_PRICE_USD raised on purpose.
export const MAX_PRICE_USD = Number(process.env.X402_MAX_PRICE_USD || "1");

/** True when a wallet-mode request may be paid at all. */
export function payableTarget(target) {
  try {
    return new URL(String(target)).origin === PAY_ORIGIN;
  } catch {
    return false;
  }
}

/** x402 PaymentPolicy: keep only requirements that pay us, in Base USDC, under the cap. */
export function payPolicy(_version, requirements) {
  const capUnits = BigInt(Math.round(MAX_PRICE_USD * 1e6)); // USDC has 6 decimals
  return (requirements || []).filter((r) => {
    try {
      const amount = BigInt(String(r.amount ?? r.maxAmountRequired ?? "-1"));
      return (
        r.network === BASE_NETWORK &&
        String(r.asset || "").toLowerCase() === BASE_USDC &&
        String(r.payTo || "").toLowerCase() === PAY_TO &&
        amount >= 0n &&
        amount <= capUnits
      );
    } catch {
      return false;
    }
  });
}
