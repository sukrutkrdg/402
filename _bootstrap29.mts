/* temp bootstrap for the stuck-29 — delete after use */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const { getPayingFetch } = await import("./src/lib/x402-client");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const WALLET = "0x973a31858f4d2125f48c880542da11a2796f12d6";
const TX = "0xca325c877f488e15c31247a1f5ba073b2f5d18f1c183c4952c0eaba55a8dc8c6";
const PAIR = "0xc9034c3E7F58003E6ae0C8438e7c8f4598d5ACAA";

function sample(name: string): string | null {
  const n = name.toLowerCase();
  if (["address", "token", "contract"].includes(n)) return USDC;
  if (n === "addresses" || n === "tokens") return `${USDC},${WETH}`;
  if (["wallet", "account", "owner", "payer"].includes(n)) return WALLET;
  if (["hash", "tx", "txhash"].includes(n)) return TX;
  if (["pair", "pool"].includes(n)) return PAIR;
  if (n === "name") return "jesse.base.eth";
  if (n === "date") return new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  if (n === "selector") return "0xa9059cbb";
  if (n === "text") return "x402 Bazaar is a pay-per-call API marketplace on Base.";
  return null;
}

const ids = (process.argv[2] || "").split(",").map((s) => s.trim()).filter(Boolean);
const cat = (await (await fetch("https://402.com.tr/api/catalog")).json()) as { services?: Array<{ id: string; input?: Record<string, { required?: boolean }> }> };
const defs = new Map((cat.services ?? []).map((s) => [s.id, s]));
const pay = getPayingFetch();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const id of ids) {
  const def = defs.get(id);
  if (!def) { console.log(`${id}: NOT-IN-CATALOG`); continue; }
  const params: Record<string, string> = {};
  let skip: string | null = null;
  for (const [pname, spec] of Object.entries(def.input ?? {})) {
    const v = sample(pname);
    if (v === null) { if (spec?.required) skip = pname; }
    else params[pname] = v;
  }
  if (skip) { console.log(`${id}: SKIP (no sample for required '${skip}')`); continue; }
  const qs = new URLSearchParams(params).toString();
  const url = `https://402.com.tr/api/x402/${id}${qs ? `?${qs}` : ""}`;
  try {
    const res = await pay(url, { headers: { "x-x402-force": "1" }, signal: AbortSignal.timeout(90_000) });
    const payResp = res.headers.get("payment-response");
    let tx = "";
    if (payResp) { try { tx = JSON.parse(Buffer.from(payResp, "base64").toString("utf8")).transaction?.slice(0, 12) ?? ""; } catch {} }
    console.log(`${id}: ${res.status}${tx ? " settled " + tx : ""}${res.status !== 200 ? " | " + (await res.text()).slice(0, 120) : ""}`);
  } catch (e) {
    console.log(`${id}: ERROR ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }
  await sleep(10_000);
}
