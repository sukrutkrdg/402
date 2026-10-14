#!/usr/bin/env node
/**
 * Find (and optionally revoke) credit balances minted by the removed
 * /api/credit/line route.
 *
 * That route wrote `credit:<sha256(token)[0:24]>` balances for anonymous
 * callers, with no payment, between its deploy (2026-10-13 ~16:00 TRT) and
 * the 410 fix (2026-10-14 ~08:10 TRT). Those keys look exactly like paid
 * prepaid credits, so this script narrows them down instead of guessing:
 *
 *   created  — derived from the key's TTL (every balance is written with a
 *              180-day TTL at mint time, so created = now - (180d - ttl))
 *   linked   — whether any `credit:owner:<addr>` set lists the key (x402
 *              purchases and recoveries link; NEAR sales do not)
 *
 * A key is SUSPECT when it was created inside the exposure window and is not
 * linked to an owner. Review the list before revoking: a NEAR credit sale in
 * that window would also be unlinked (check /stats for NEAR sales).
 *
 * Usage (needs the production Upstash REST credentials):
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *     node scripts/audit-credit-line-tokens.mjs            # report only
 *   ... node scripts/audit-credit-line-tokens.mjs --revoke # delete SUSPECT keys
 *   ... --token ck_...   also revoke one known token by its value
 *   ... --from 2026-10-13T12:00:00Z --to 2026-10-14T06:00:00Z  override window
 */
import { createHash } from "node:crypto";

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!URL_ || !TOKEN) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN).");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const REVOKE = args.includes("--revoke");
// Window in UTC: deploy of cb8b0ca (13 Oct 16:04 TRT = 13:04Z) to the 410 fix (14 Oct ~05:10Z), padded.
const FROM = Date.parse(flag("--from") ?? "2026-10-13T12:30:00Z");
const TO = Date.parse(flag("--to") ?? "2026-10-14T05:30:00Z");
const KNOWN_TOKEN = flag("--token");
const BALANCE_TTL = 60 * 60 * 24 * 180;

async function cmd(...c) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(c),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${c[0]}: ${j.error}`);
  return j.result;
}

async function scan(match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await cmd("SCAN", cursor, "MATCH", match, "COUNT", 1000);
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");
  return keys;
}

const keyFor = (token) => `credit:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;

const balanceKeys = (await scan("credit:*")).filter((k) => /^credit:[0-9a-f]{24}$/.test(k));
const linked = new Set();
for (const ok of await scan("credit:owner:*")) for (const m of await cmd("SMEMBERS", ok)) linked.add(m);

const now = Date.now();
const rows = [];
for (const key of balanceKeys) {
  const [cents, ttl] = await Promise.all([cmd("GET", key), cmd("TTL", key)]);
  const created = ttl > 0 ? now - (BALANCE_TTL - ttl) * 1000 : null;
  const inWindow = created !== null && created >= FROM && created <= TO;
  const isLinked = linked.has(key);
  rows.push({ key, cents: Number(cents), created: created ? new Date(created).toISOString() : "no-ttl", linked: isLinked, suspect: inWindow && !isLinked });
}
rows.sort((a, b) => String(a.created).localeCompare(String(b.created)));

console.log(`credit balance keys: ${rows.length} · linked to an owner: ${rows.filter((r) => r.linked).length}`);
console.log(`exposure window: ${new Date(FROM).toISOString()} → ${new Date(TO).toISOString()}\n`);
console.table(rows);

const suspects = rows.filter((r) => r.suspect).map((r) => r.key);
if (KNOWN_TOKEN) suspects.push(keyFor(KNOWN_TOKEN));
const unique = [...new Set(suspects)];
console.log(`\nSUSPECT keys: ${unique.length} · outstanding ¢: ${rows.filter((r) => unique.includes(r.key)).reduce((s, r) => s + r.cents, 0)}`);

if (!REVOKE) {
  console.log("Report only. Re-run with --revoke to delete the SUSPECT keys.");
} else {
  for (const k of unique) {
    await cmd("DEL", k, `${k}:mills`);
    console.log(`revoked ${k}`);
  }
}
