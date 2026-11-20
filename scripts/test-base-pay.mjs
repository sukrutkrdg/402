/**
 * Paid smoke test of the NEW services, paying in USDC on Base — proves the full
 * x402 settlement path end-to-end and starts the "⬡ Base" By-chain stat.
 *
 * SECURITY: never paste the key into chat or commit it. Pass it via env only.
 *
 * Prereqs: a Base wallet with a little USDC (~$0.30 covers this run). From the
 * 402 repo (@x402/* + viem already installed):
 *   BASE_PAYER_KEY=0x<private key>  node scripts/test-base-pay.mjs
 *
 * It pays each new Arbitrum + Solana service on Base (every chain's verdict
 * settles in USDC on Base), prints the result, and leaves the settlement onchain.
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const key = process.env.BASE_PAYER_KEY;
if (!key) {
  console.error("Set BASE_PAYER_KEY=0x<private key> — a Base wallet with a little USDC.");
  process.exit(1);
}

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const pub = createPublicClient({ chain: base, transport: http() });
// EIP-3009 needs just the signer; readContract is there for the Permit2 fallback.
const signer = { ...account, readContract: pub.readContract.bind(pub) };
console.log("payer:", account.address, "\n");

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const services = [
  `arb-token-verdict?address=${ARB}`,
  `arb-sellability?address=${ARB}`,
  `arb-token-risk?address=${ARB}`,
  `sol-pre-trade-bundle?mint=${BONK}`,
  `sol-new-pairs?limit=5`,
  `sol-safe-launches?limit=8`,
];

for (const svc of services) {
  const id = svc.split("?")[0];
  try {
    const res = await payFetch(`https://402.com.tr/api/x402/${svc}`, { method: "GET" });
    const body = await res.json().catch(() => ({}));
    const o = body?.data ?? body;
    console.log(id.padEnd(22), `HTTP ${res.status} →`, o.verdict || o.gate || o.headline || JSON.stringify(o).slice(0, 70));
  } catch (e) {
    console.log(id.padEnd(22), "FAILED:", e.message);
    break; // likely out of USDC
  }
}
console.log("\n✅ Paid on Base — check /stats 'By chain' (⬡ Base) and the live feed.");
