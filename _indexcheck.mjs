/* temp: scan CDP x402 discovery for our services — delete after use */
const WANT = ["/api/x402/b20-dossier","/api/x402/b20-authenticity","/api/x402/b20-config-audit","/api/x402/b20-policy-members","/api/x402/b20-genesis-audit","/api/x402/b20-mint-watch","/api/x402/b20-rebase-history","/api/x402/b20-peg"];
const OURS = "402.com.tr";
const found = new Set();
let ourCount = 0;
let offset = 0;
const limit = 100;
for (let page = 0; page < 200; page++) {
  const r = await fetch(
    `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=${limit}&offset=${offset}`,
  );
  if (!r.ok) { console.log(`page ${page} -> HTTP ${r.status}, stopping`); break; }
  const j = await r.json();
  const items = j.items ?? [];
  if (items.length === 0) break;
  for (const it of items) {
    const res = it.resource ?? it.url ?? "";
    if (typeof res === "string" && res.includes(OURS)) {
      ourCount++;
      for (const w of WANT) if (res.includes(w)) found.add(w);
    }
  }
  offset += items.length;
}
console.log(`scanned ${offset} resources`);
console.log(`our (${OURS}) services indexed: ${ourCount}`);
for (const w of WANT) console.log(`${w}: ${found.has(w) ? "INDEXED" : "not yet"}`);
