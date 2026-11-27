/** Paid accuracy check — known tokens, known expected verdicts + full reasons. */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const key = process.env.BASE_PAYER_KEY;
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const pub = createPublicClient({ chain: base, transport: http() });
const client = new x402Client();
registerExactEvmScheme(client, { signer: { ...account, readContract: pub.readContract.bind(pub) } });
const payFetch = wrapFetchWithPayment(fetch, client);

const CHECKS = [
  { svc: "token-verdict", q: "address=0x4200000000000000000000000000000000000006", name: "WETH (Base)", expect: "SAFE" },
  { svc: "sol-token-verdict", q: "mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USDC (Solana)", expect: "CAUTION (freeze authority)" },
  { svc: "sol-token-verdict", q: "mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "BONK (Solana)", expect: "CAUTION (LP/concentration)" },
  { svc: "arb-token-verdict", q: "address=0x912CE59144191C1204E64559FE8253a0e49E6548", name: "ARB (Arbitrum)", expect: "CAUTION (proxy/owner)" },
];

for (const c of CHECKS) {
  try {
    const res = await payFetch(`https://402.com.tr/api/x402/${c.svc}?${c.q}`, { method: "GET" });
    const o = (await res.json().catch(() => ({})));
    const d = o.data ?? o;
    console.log(`\n${c.name} — expected ${c.expect}`);
    console.log(`  → ${d.verdict} (${d.confidence})`);
    (d.reasons || []).slice(0, 3).forEach((r) => console.log(`    • ${r}`));
  } catch (e) {
    console.log(`${c.name}: FAILED ${e.message}`);
  }
}
