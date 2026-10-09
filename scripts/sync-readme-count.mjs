// Sync the README service count + date to the live catalogue (single source of
// truth = the public /api/catalog). Updates the badge, the badge alt-text and the
// "N public services as of DATE" line. Pass a number to override the live fetch
// (e.g. CI before deploy): `node scripts/sync-readme-count.mjs 217`.
//
//   npm run sync:count      → reads the live catalogue
//   npm run sync:count 217  → forces the count
import { readFileSync, writeFileSync } from "node:fs";

const CATALOG = process.env.CATALOG_URL || "https://402.com.tr/api/catalog";
const README = "README.md";

async function liveCount() {
  const r = await fetch(CATALOG, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`catalogue fetch ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.services;
  if (!Array.isArray(list)) throw new Error("unexpected catalogue shape");
  return list.length;
}

const override = Number(process.argv[2]);
const count = Number.isFinite(override) && override > 0 ? override : await liveCount();
const today = new Date().toISOString().slice(0, 10);

let md = readFileSync(README, "utf8");
const before = md;
// Keep the existing "as of" date when the count hasn't changed — the date marks
// the last COUNT change, not every sync run, so the daily job makes no noise.
const curLine = md.match(/^(\d+) public services as of (\d{4}-\d{2}-\d{2})/m);
const curCount = curLine ? Number(curLine[1]) : null;
const date = curCount === count && curLine ? curLine[2] : today;
md = md
  .replace(/live%20APIs-\d+-0052FF/g, `live%20APIs-${count}-0052FF`)
  .replace(/Live APIs: \d+/g, `Live APIs: ${count}`)
  .replace(/^\d+ public services as of \d{4}-\d{2}-\d{2}/m, `${count} public services as of ${date}`);

if (md === before) {
  console.log(`README already in sync (count=${count}, date=${today}).`);
} else {
  writeFileSync(README, md);
  console.log(`README synced → ${count} public services as of ${today}.`);
}
