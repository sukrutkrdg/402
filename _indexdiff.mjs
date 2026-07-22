/* temp: catalog vs discovery diff */
const cat = await (await fetch("https://402.com.tr/api/catalog")).json();
const services = cat.services ?? cat.items ?? cat;
const indexed = new Set();
let offset = 0;
for (let page = 0; page < 200; page++) {
  const r = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`);
  if (!r.ok) break;
  const j = await r.json();
  const items = j.items ?? [];
  if (!items.length) break;
  for (const it of items) {
    const res = it.resource ?? it.url ?? "";
    const m = typeof res === "string" && res.match(/402\.com\.tr\/api\/x402\/([\w-]+)/);
    if (m) indexed.add(m[1]);
  }
  offset += items.length;
}
const inIdx = [], notIdx = [];
for (const s of services) (indexed.has(s.id) ? inIdx : notIdx).push(s);
console.log(`catalog(visible): ${services.length} | indexed: ${inIdx.length} | NOT indexed: ${notIdx.length}`);
console.log(`(discovery'de bizden toplam ${indexed.size} kayıt — katalog dışı/hidden dahil)`);
let cost = 0;
console.log("\nNOT INDEXED:");
for (const s of notIdx) {
  const p = Number(String(s.price ?? "0").replace("$", "")) || 0;
  cost += p;
  console.log(`  ${s.price ?? "?"}  ${s.id}`);
}
console.log(`\ntoplam bootstrap maliyeti: $${cost.toFixed(2)}`);
const extra = [...indexed].filter((id) => !services.some((s) => s.id === id));
if (extra.length) console.log("index'te olup katalogda olmayan (hidden/eski):", extra.join(", "));
