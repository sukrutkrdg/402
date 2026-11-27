/**
 * FULL paid sweep — pays EVERY catalog service for real in USDC on Base (every
 * chain's verdict settles on Base) and reports settlement + result correctness.
 * This is the end-to-end proof the free sweep can't give: it exercises the real
 * x402 402→pay→retry path, not the free-tier bypass.
 *
 *   BUDGET_USD=10 node scripts/paid-sweep.mjs            # key from .env.local
 *   BASE_PAYER_KEY=0x… BUDGET_USD=10 node scripts/paid-sweep.mjs
 *
 * SECURITY: the key is read from env/.env.local and never printed.
 * Self-referential and offline services are skipped (buy-credits, log-analyze).
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const HOST = process.env.HOST || "https://402.com.tr";
const BUDGET = Number(process.env.BUDGET_USD || "10");
// Sequential by default: 3 concurrent EIP-3009 settlements from one payer wallet
// drew transient 402s from the facilitator (race), which look like service
// failures but settle instantly on a sequential retry. Override with CONCURRENCY.
const CONCURRENCY = Number(process.env.CONCURRENCY || "1");
const SKIP = new Set(["buy-credits", "log-analyze"]); // self-pay / backend offline

// key: env first, else .env.local
let key = process.env.BASE_PAYER_KEY;
if (!key) {
  try {
    const env = Object.fromEntries(
      readFileSync(new URL("../.env.local", import.meta.url), "utf8")
        .split(/\r?\n/).filter((l) => l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
    );
    key = env.BUYER_PRIVATE_KEY;
  } catch { /* ignore */ }
}
if (!key) { console.error("No key — set BASE_PAYER_KEY or BUYER_PRIVATE_KEY in .env.local"); process.exit(1); }

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || undefined) });
const signer = { ...account, readContract: pub.readContract.bind(pub) };
console.log("payer:", account.address, "| budget: $" + BUDGET.toFixed(2), "| host:", HOST, "\n");

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const payFetch = wrapFetchWithPayment(fetch, client);

function priceUsd(s) {
  const p = s.price ?? s.accepts?.[0]?.price ?? s.maxAmountRequired;
  if (typeof p === "string") { const n = Number(p.replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; }
  return typeof p === "number" ? p : 0;
}

const doc = await (await fetch(`${HOST}/.well-known/x402`)).json();
// cheapest-first: a tight budget then covers the MOST services, deferring only
// the few priciest (which we verify separately) instead of a random tail.
const all = (doc.services || []).filter((s) => !SKIP.has(s.id)).sort((a, b) => priceUsd(a) - priceUsd(b));
console.log(`Catalog: ${doc.services?.length} services, paying ${all.length} (skipped ${[...SKIP].join(", ")}).\n`);
function urlFor(s) {
  const qs = new URLSearchParams();
  for (const [name, spec] of Object.entries(s.input || {})) {
    if (spec && spec.example != null) qs.set(name, String(spec.example));
  }
  return `${HOST}/api/x402/${s.id}${qs.toString() ? "?" + qs.toString() : ""}`;
}

let spent = 0, stopped = false;
const results = [];

async function pay(s) {
  if (stopped) return { s, cat: "skip", note: "budget stop" };
  const price = priceUsd(s);
  try {
    const res = await payFetch(urlFor(s), { method: s.method === "POST" ? "POST" : "GET" });
    const body = await res.json().catch(() => ({}));
    const o = body?.data ?? body;
    const settled = res.status === 200;
    if (settled) spent += price;
    const verdict = o?.verdict || o?.gate || o?.level || o?.pegVerdict || o?.headline?.slice(0, 50) || (o?.error ? `ERR:${String(o.error).slice(0, 40)}` : "ok");
    const bad = !settled || o?.error || o?.ok === false;
    return { s, price, cat: bad ? "fail" : "ok", http: res.status, note: verdict, data: o };
  } catch (e) {
    const msg = e?.message || String(e);
    if (/insufficient|balance|exceed|budget/i.test(msg)) { stopped = true; return { s, cat: "nofunds", note: msg.slice(0, 50) }; }
    return { s, cat: "fail", note: msg.slice(0, 60) };
  }
}

for (let i = 0; i < all.length; i += CONCURRENCY) {
  if (spent >= BUDGET) { stopped = true; }
  const batch = all.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(pay))));
  process.stdout.write(`\r  ${results.length}/${all.length}  spent ~$${spent.toFixed(2)}`);
}
console.log("\n");

const fails = results.filter((r) => r.cat === "fail");
const nofunds = results.filter((r) => r.cat === "nofunds" || r.cat === "skip");
const ok = results.filter((r) => r.cat === "ok");
console.log(`✅ paid OK: ${ok.length}   ❌ FAIL: ${fails.length}   ⏸ not reached (budget): ${nofunds.length}`);
console.log(`💵 spent ~$${spent.toFixed(2)} of $${BUDGET.toFixed(2)}\n`);
if (fails.length) {
  console.log("FAILURES:");
  for (const r of fails) console.log(`  ✗ ${r.s.id.padEnd(26)} HTTP ${r.http ?? "-"}  ${r.note}`);
}
// A few sampled OK verdicts so the result (not just the HTTP) is visible.
console.log("\nSample results:");
for (const r of ok.slice(0, 12)) console.log(`  ✓ ${r.s.id.padEnd(26)} $${(r.price ?? 0).toFixed(3)}  ${r.note}`);
if (nofunds.length) console.log(`\n⏸ ${nofunds.length} not reached — top up and re-run to finish.`);

// Full machine-readable dump so the ACTUAL returned data (not just HTTP) is auditable.
import("node:fs").then((fs) => {
  const dump = results.map((r) => ({ id: r.s.id, price: r.price ?? 0, cat: r.cat, http: r.http ?? null, data: r.data ?? null }));
  fs.writeFileSync(new URL("./paid-sweep-results.json", import.meta.url), JSON.stringify(dump, null, 1));
  console.log(`\n📝 full returned data → scripts/paid-sweep-results.json (${dump.length} records)`);
});
