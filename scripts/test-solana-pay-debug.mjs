/** Debug the Solana x402 payment step by step — prints why a 402 came back. */
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

const secret = process.env.SOLANA_PAYER_SECRET;
const bytes = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim());
const signer = await createKeyPairSignerFromBytes(bytes);
console.log("payer:", signer.address);

// Default selector picks accepts[0] (= Base here); force the Solana entry so the
// SVM scheme we registered is the one that builds the payload.
const selectSolana = (_v, accepts) => accepts.find((a) => String(a.network).startsWith("solana")) ?? accepts[0];
const client = new x402Client(selectSolana);
registerExactSvmScheme(client, { signer });
const httpClient = new x402HTTPClient(client);

const url = "https://402.com.tr/api/x402/sol-token-verdict?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const r1 = await fetch(url);
console.log("1st status:", r1.status);
const text = await r1.text();
const body = text ? JSON.parse(text) : undefined;
console.log("accepts networks:", (body?.accepts || []).map((a) => a.network));

const paymentRequired = httpClient.getPaymentRequiredResponse((n) => r1.headers.get(n), body);

let payload;
try {
  console.log("selector picks:", JSON.stringify(selectSolana(2, body?.accepts || [])));
  payload = await client.createPaymentPayload(paymentRequired);
  console.log("→ FULL payload:", JSON.stringify(payload, null, 2)?.slice(0, 1500));
} catch (e) {
  console.log("✗ createPaymentPayload THREW:", e?.message);
  console.log(e);
  process.exit(1);
}

const headers = httpClient.encodePaymentSignatureHeader(payload);
const r2 = await fetch(url, { headers });
console.log("2nd status:", r2.status);
const pr = r2.headers.get("payment-response") ?? r2.headers.get("x-payment-response");
if (pr) {
  try { console.log("PAYMENT-RESPONSE:", JSON.parse(Buffer.from(pr, "base64").toString("utf8"))); }
  catch { console.log("PAYMENT-RESPONSE (raw):", pr); }
}
for (const h of ["x-error", "x-refunded", "x-paid-via", "www-authenticate"]) {
  const v = r2.headers.get(h);
  if (v) console.log(`${h}:`, v);
}
const t2 = await r2.text();
console.log("2nd body:", t2.slice(0, 1200));
