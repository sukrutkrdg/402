/**
 * Pay a cheap x402 Bazaar endpoint in USDC ON SOLANA — the real end-to-end test.
 *
 * SECURITY: never paste a secret key into chat or commit it. Pass the PAYER's
 * secret via an env var only, locally.
 *
 * Prereqs:
 *   - a funded Solana payer wallet (a little USDC on Solana mainnet; CDP sponsors
 *     the SOL gas, so you only need USDC — ~$0.05 is plenty for a $0.03 call).
 *   - from the 402 repo (@x402/fetch + @x402/svm are already installed), add:
 *       npm i @solana/kit bs58
 *
 * Run (secret as a base58 string OR a JSON byte array, your choice):
 *   SOLANA_PAYER_SECRET='4xk...base58...'  node scripts/test-solana-pay.mjs
 *   SOLANA_PAYER_SECRET='[12,34,...]'       node scripts/test-solana-pay.mjs
 *
 * It calls sol-token-verdict, which quotes BOTH Base and Solana; this client only
 * registers the Solana scheme, so it pays on Solana → USDC lands at SOLANA_PAY_TO
 * (4au4…). Prints the verdict + the settlement proof.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

const secret = process.env.SOLANA_PAYER_SECRET;
if (!secret) {
  console.error("Set SOLANA_PAYER_SECRET (base58 string or JSON byte array) — a FUNDED Solana payer.");
  process.exit(1);
}
const bytes = secret.trim().startsWith("[")
  ? Uint8Array.from(JSON.parse(secret))
  : bs58.decode(secret.trim());

const signer = await createKeyPairSignerFromBytes(bytes);
console.log("payer:", signer.address);

const client = new x402Client();
registerExactSvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const url =
  "https://402.com.tr/api/x402/sol-token-verdict?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
console.log("Paying $0.03 USDC on Solana for:\n ", url, "\n");

const res = await payFetch(url, { method: "GET" });
console.log("HTTP", res.status);
const body = await res.json();
console.log(JSON.stringify(body?.data ?? body, null, 2));

const pr = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
if (pr) {
  try {
    console.log("\nsettlement proof:", JSON.parse(Buffer.from(pr, "base64").toString("utf8")));
  } catch {
    console.log("\npayment-response header:", pr);
  }
}
console.log("\n✅ If HTTP 200 + a verdict above, USDC settled on Solana → check SOLANA_PAY_TO on explorer.solana.com");
