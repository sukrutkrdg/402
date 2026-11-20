/**
 * Catalog health sweep — hit EVERY service on the free tier with its own example
 * input (from the discovery doc) and report which ones are broken.
 *
 *   node scripts/health-sweep.mjs
 *
 * Categorizes: ok (200 + no error), paid-only (freeTier:false → 402, expected),
 * FAIL (4xx/5xx/error/timeout — the ones to fix).
 */
const HOST = process.env.HOST || "https://402.com.tr";
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;

const doc = await (await fetch(`${HOST}/.well-known/x402`)).json();
const services = (doc.services || []).filter((s) => s.method !== "POST" || true);
console.log(`Sweeping ${services.length} services on ${HOST} …\n`);

function urlFor(s) {
  const qs = new URLSearchParams();
  for (const [name, spec] of Object.entries(s.input || {})) {
    if (spec && spec.example != null) qs.set(name, String(spec.example));
  }
  qs.set("free", "1");
  return `${HOST}/api/x402/${s.id}?${qs.toString()}`;
}

async function check(s) {
  const url = urlFor(s);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.json().catch(() => ({}));
    const o = body?.data ?? body;
    if (res.status === 402) return { s, cat: s.freeTier === false ? "paid" : "fail", note: "402" };
    if (!res.ok) return { s, cat: "fail", note: `HTTP ${res.status}` };
    if (o && (o.error || o.ok === false)) return { s, cat: "fail", note: `error: ${String(o.error || o.message || "").slice(0, 60)}` };
    return { s, cat: "ok", note: o?.verdict || o?.gate || o?.level || o?.headline?.slice(0, 40) || "ok" };
  } catch (e) {
    return { s, cat: "fail", note: e.name === "AbortError" ? "timeout" : e.message.slice(0, 50) };
  }
}

const results = [];
for (let i = 0; i < services.length; i += CONCURRENCY) {
  const batch = services.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(check))));
  process.stdout.write(`\r  ${results.length}/${services.length}`);
}
process.stdout.write("\n\n");

const by = (c) => results.filter((r) => r.cat === c);
console.log(`✅ ok: ${by("ok").length}   ⚠️ paid-only: ${by("paid").length}   ❌ FAIL: ${by("fail").length}\n`);
if (by("fail").length) {
  console.log("❌ FAILURES (fix these):");
  for (const r of by("fail")) console.log(`  • ${r.s.id.padEnd(28)} ${r.note}`);
} else {
  console.log("🎉 No failures — every free-tier service answered.");
}
