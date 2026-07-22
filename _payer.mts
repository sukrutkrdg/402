/* temp payer analysis — delete after use */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
async function cdpSql<T>(sql: string): Promise<T[] | null> {
  const jwt = await generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    requestMethod: "POST",
    requestHost: "api.cdp.coinbase.com",
    requestPath: "/platform/v2/data/query/run",
  });
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/data/query/run", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) { console.error("SQL fail", r.status, await r.text()); return null; }
  const j = (await r.json()) as { result?: T[] };
  return j.result ?? [];
}

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYTO = "0x973a31858f4d2125f48c880542da11a2796f12d6";
const PAYER = (process.argv[2] || "0x7e571e959cc7c75ccdd2eac24f8775ea2eaa2f09").toLowerCase();

type Row = { block_timestamp?: string; transaction_hash?: string; parameters?: { from?: string; to?: string; value?: string } };

// 1) payer -> payTo, last 7 days
const toUs = await cdpSql<Row>(
  `SELECT block_timestamp, transaction_hash, parameters FROM base.events WHERE address = '${USDC}' AND event_signature = 'Transfer(address,address,uint256)' AND parameters['from'] = '${PAYER}' AND parameters['to'] = '${PAYTO}' AND block_timestamp > now() - INTERVAL 7 DAY ORDER BY block_timestamp ASC LIMIT 100`,
);
console.log("=== payer -> payTo (7d) ===");
for (const r of toUs ?? []) {
  const usd = Number(r.parameters?.value ?? 0) / 1e6;
  console.log(`${r.block_timestamp}  $${usd.toFixed(3)}  ${r.transaction_hash}`);
}
console.log("count:", toUs?.length ?? 0, " total: $", ((toUs ?? []).reduce((a, r) => a + Number(r.parameters?.value ?? 0), 0) / 1e6).toFixed(3));

// 2) payer -> anyone else (7d) — is it shopping across other x402 sellers?
const elsewhere = await cdpSql<Row>(
  `SELECT block_timestamp, transaction_hash, parameters FROM base.events WHERE address = '${USDC}' AND event_signature = 'Transfer(address,address,uint256)' AND parameters['from'] = '${PAYER}' AND parameters['to'] != '${PAYTO}' AND block_timestamp > now() - INTERVAL 7 DAY ORDER BY block_timestamp DESC LIMIT 100`,
);
console.log("\n=== payer -> others (7d) ===");
const byDest = new Map<string, { n: number; usd: number }>();
for (const r of elsewhere ?? []) {
  const to = r.parameters?.to ?? "?";
  const e = byDest.get(to) ?? { n: 0, usd: 0 };
  e.n++; e.usd += Number(r.parameters?.value ?? 0) / 1e6;
  byDest.set(to, e);
}
for (const [to, e] of byDest) console.log(`${to}  x${e.n}  $${e.usd.toFixed(3)}`);

// 3) where does the payer get funded from? (last inbound, 30d)
const funding = await cdpSql<Row>(
  `SELECT block_timestamp, transaction_hash, parameters FROM base.events WHERE address = '${USDC}' AND event_signature = 'Transfer(address,address,uint256)' AND parameters['to'] = '${PAYER}' AND block_timestamp > now() - INTERVAL 30 DAY ORDER BY block_timestamp DESC LIMIT 10`,
);
console.log("\n=== inbound funding (30d, last 10) ===");
for (const r of funding ?? []) {
  const usd = Number(r.parameters?.value ?? 0) / 1e6;
  console.log(`${r.block_timestamp}  $${usd.toFixed(3)}  from ${r.parameters?.from}  ${r.transaction_hash}`);
}
