/**
 * Drain the throwaway payer by paying several Solana services in sequence —
 * populates the "By chain · Solana" dashboard counters with real settlements.
 * Key from --env-file=.env.test (gitignored). CDP sponsors the SOL gas.
 */
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import bs58 from "bs58";

const secret = process.env.SOLANA_PAYER_SECRET;
const bytes = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim());
const signer = await createKeyPairSignerFromBytes(bytes);
console.log("payer:", signer.address, "\n");

const selectSolana = (_v, accepts) => accepts.find((a) => String(a.network).startsWith("solana")) ?? accepts[0];
const client = new x402Client(selectSolana);
registerExactSvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const services = ["sol-pre-trade-gate", "sol-token-risk", "sol-lp-check", "sol-price"]; // $0.04+0.02+0.02+0.01 = $0.09

for (const svc of services) {
  try {
    const res = await payFetch(`https://402.com.tr/api/x402/${svc}?mint=${BONK}`, { method: "GET" });
    const body = await res.json().catch(() => ({}));
    const o = body?.data ?? body;
    console.log(`${svc.padEnd(26)} HTTP ${res.status} →`, o.headline || o.gate || o.score || JSON.stringify(o).slice(0, 80));
  } catch (e) {
    console.log(`${svc.padEnd(26)} FAILED:`, e.message);
    break; // likely out of USDC
  }
}
console.log("\n✅ Paid on Solana — check /stats 'By chain' (◎ Solana) and the live feed.");
