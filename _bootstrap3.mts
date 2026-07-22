/* temp bootstrap script — delete after use */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const svc = process.argv[2];
const qs = process.argv[3];
if (!svc || !qs) {
  console.error("usage: tsx _bootstrap3.mts <service-id> <querystring>");
  process.exit(1);
}

const realFetch = globalThis.fetch;
let hop = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  hop++;
  const h = new Headers(init?.headers);
  if (input instanceof Request) for (const [k, v] of input.headers) if (!h.has(k)) h.set(k, v);
  const allHeaderNames = [...h.keys()].join(",");
  const payHeaderName = [...h.keys()].find((k) => k.toLowerCase().includes("payment"));
  const u = typeof input === "string" ? input : input?.url ?? String(input);
  console.log(`[hop ${hop}] ${init?.method ?? (input instanceof Request ? input.method : "GET")} ${u.slice(0, 110)}`);
  console.log(`[hop ${hop}] req headers: ${allHeaderNames || "(none)"}`);
  if (payHeaderName) {
    try { console.log(`[hop ${hop}] ${payHeaderName}:`, Buffer.from(h.get(payHeaderName)!, "base64").toString("utf8").slice(0, 700)); } catch {}
  }
  const res = await realFetch(input, init);
  console.log(`[hop ${hop}] -> ${res.status}`);
  const pr = res.headers.get("payment-required");
  if (res.status === 402 && pr) {
    try {
      const dec = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
      console.log(`[hop ${hop}] 402 error field (full):`, dec.error ?? dec.errorReason ?? null);
    } catch {}
  }
  return res;
}) as typeof fetch;

const { getPayingFetch, getBuyerAddress } = await import("./src/lib/x402-client");

const url = `https://402.com.tr/api/x402/${svc}?${qs}`;
console.log(`buyer: ${getBuyerAddress()}`);
console.log(`POST-pay GET ${url}`);

const payingFetch = getPayingFetch();
const t0 = Date.now();
try {
  const res = await payingFetch(url, {
    headers: { "x-x402-force": "1" },
    signal: AbortSignal.timeout(120_000),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const body = await res.text();
  console.log(`status=${res.status} elapsed=${elapsed}s`);
  const payResp = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (payResp) {
    try {
      const decoded = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
      console.log("payment-response:", JSON.stringify(decoded));
    } catch {
      console.log("payment-response (raw):", payResp.slice(0, 300));
    }
  }
  console.log("body:", body.slice(0, 1500));
} catch (e) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`FAILED after ${elapsed}s:`, e instanceof Error ? e.message : e);
  if (e instanceof Error && e.cause) console.error("cause:", e.cause);
  process.exit(2);
}
