/**
 * Differentiated on-chain forensics — the reads agents need that nobody else
 * serves: is a token's volume real, was its launch sniped, and who controls a
 * contract right now.
 *
 *   wash-trading   — round-trip / circular-flow detection from transfer events
 *   launch-snipers — the first buyers of a token and whether they were bundled
 *   contract-owner — owner / admin / proxy-admin, read straight from the chain
 *
 * The two event-based reads use address-filtered, time-bounded CDP SQL (the
 * reliable warehouse path); contract-owner is pure on-chain. Each is a heuristic
 * SIGNAL, said as such — never proof — and an unreadable source is surfaced, not
 * guessed.
 */

import "server-only";
import { createPublicClient, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { cdpSql } from "./covalent";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
const validAddr = (a?: string) => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());
const TRANSFER = "Transfer(address,address,uint256)";

// ---------------------------------------------------------------------------
// wash-trading — circular / round-trip flow signal
// ---------------------------------------------------------------------------

export async function washTrading(params: Record<string, string>) {
  const token = (params.address || params.token || "").trim().toLowerCase();
  if (!validAddr(token)) throw new Error("Provide a token contract address (address=0x…)");
  const days = Math.min(Math.max(Number(params.days) || 7, 1), 30);
  const q = (sel: string) =>
    `SELECT ${sel} AS a, count(*) AS c FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND block_timestamp > now() - INTERVAL ${days} DAY GROUP BY ${sel} ORDER BY c DESC LIMIT 25`;

  const [senders, receivers, totals] = await Promise.all([
    cdpSql<{ a?: string; c?: string }>(q("lower(toString(parameters['from']))")),
    cdpSql<{ a?: string; c?: string }>(q("lower(toString(parameters['to']))")),
    cdpSql<{ n?: string; sf?: string; st?: string }>(
      `SELECT count(*) AS n, count(DISTINCT lower(toString(parameters['from']))) AS sf, count(DISTINCT lower(toString(parameters['to']))) AS st FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' AND block_timestamp > now() - INTERVAL ${days} DAY`,
    ),
  ]);
  if (senders === null || receivers === null || totals === null) {
    throw new Error("Transfer data unavailable (warehouse) — not charged, retry shortly");
  }
  const total = Number(totals[0]?.n ?? 0);
  if (total === 0) return { address: token, days, totalTransfers: 0, verdict: "no_activity", note: "No transfers in the window.", checkedAt: new Date().toISOString() };

  const sMap = new Map(senders.map((r) => [r.a ?? "", Number(r.c)]));
  const rMap = new Map(receivers.map((r) => [r.a ?? "", Number(r.c)]));
  // Round-trippers: addresses heavy on BOTH sides. Their min(sent,received) is
  // transfer volume that went out and came back — the wash shape.
  const roundTrip: Array<{ address: string; sent: number; received: number }> = [];
  for (const [a, sent] of sMap) {
    const received = rMap.get(a) ?? 0;
    if (a && received > 0 && sent > 0) roundTrip.push({ address: a, sent, received });
  }
  roundTrip.sort((x, y) => Math.min(y.sent, y.received) - Math.min(x.sent, x.received));
  const roundTripVol = roundTrip.reduce((s, r) => s + Math.min(r.sent, r.received), 0);
  const roundTripPct = +((roundTripVol / total) * 100).toFixed(1);
  // Concentration: few distinct participants driving many transfers.
  const distinct = Math.max(Number(totals[0]?.sf ?? 0), Number(totals[0]?.st ?? 0));
  const perParticipant = distinct > 0 ? +(total / distinct).toFixed(1) : null;

  const verdict = roundTripPct >= 30 ? "likely_wash" : roundTripPct >= 12 ? "elevated" : "clean";
  return {
    address: token,
    days,
    totalTransfers: total,
    distinctParticipants: distinct,
    transfersPerParticipant: perParticipant,
    roundTripPct, // share of transfers among addresses active on both sides
    topRoundTrippers: roundTrip.slice(0, 5),
    verdict, // clean | elevated | likely_wash | no_activity
    recommendation:
      verdict === "likely_wash"
        ? `⚠️ ${roundTripPct}% of transfers round-trip through addresses active on both sides — the wash/circular shape. Treat the reported volume as inflated; do not size off it.`
        : verdict === "elevated"
          ? `${roundTripPct}% round-trips through dual-sided addresses — some circular flow. Real volume is likely below the headline.`
          : `Only ${roundTripPct}% round-trips; volume looks organic over ${days}d. (A heuristic from top participants, not proof.)`,
    note: "Heuristic wash-trading signal from transfer events (CDP SQL): share of transfers round-tripping through addresses heavy on both the send and receive side, plus participant concentration. A signal, not proof — LPs/routers legitimately appear on both sides. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// launch-snipers — first buyers and bundle detection
// ---------------------------------------------------------------------------

export async function launchSnipers(params: Record<string, string>) {
  const token = (params.address || params.token || "").trim().toLowerCase();
  if (!validAddr(token)) throw new Error("Provide a token contract address (address=0x…)");
  const n = Math.min(Math.max(Number(params.first) || 40, 5), 100);

  const rows = await cdpSql<{ to?: string; from?: string; b?: string }>(
    `SELECT lower(toString(parameters['to'])) AS to, lower(toString(parameters['from'])) AS from, block_number AS b FROM base.events WHERE address='${token}' AND event_signature='${TRANSFER}' ORDER BY block_timestamp ASC LIMIT ${n}`,
  );
  if (rows === null) throw new Error("Transfer data unavailable (warehouse) — not charged, retry shortly");
  if (rows.length === 0) return { address: token, verdict: "no_activity", note: "No transfers found for this token.", checkedAt: new Date().toISOString() };

  const firstBlock = Number(rows[0].b);
  // Recipients that are not the zero address (mints) or the token itself.
  const recips = rows.map((r) => r.to ?? "").filter((a) => /^0x[0-9a-f]{40}$/.test(a) && a !== "0x0000000000000000000000000000000000000000" && a !== token);
  const distinct = new Set(recips);
  // Same-block clustering: many recipients sharing the earliest block(s) = a bundle.
  const byBlock = new Map<number, number>();
  for (const r of rows) { const b = Number(r.b); byBlock.set(b, (byBlock.get(b) ?? 0) + 1); }
  const maxInOneBlock = Math.max(...byBlock.values());
  const earlyBlockSpan = Number(rows[rows.length - 1].b) - firstBlock;

  const bundled = maxInOneBlock >= 5 || (distinct.size >= 8 && earlyBlockSpan <= 3);
  const concentrated = distinct.size <= Math.max(3, Math.floor(rows.length * 0.25));

  const verdict = bundled ? "bundled_launch" : concentrated ? "concentrated" : "organic";
  return {
    address: token,
    analysedTransfers: rows.length,
    firstBlock,
    distinctEarlyHolders: distinct.size,
    maxRecipientsInOneBlock: maxInOneBlock,
    earlyBlockSpan,
    firstHolders: [...distinct].slice(0, 10),
    verdict, // organic | concentrated | bundled_launch | no_activity
    recommendation:
      verdict === "bundled_launch"
        ? `⚠️ Bundled launch shape: ${maxInOneBlock} recipients in a single early block / tight ${earlyBlockSpan}-block span — coordinated sniping, not organic distribution. Expect correlated dumping.`
        : verdict === "concentrated"
          ? `Early supply went to only ${distinct.size} holders across the first ${rows.length} transfers — concentrated; a few wallets can move the price.`
          : `Early distribution spread across ${distinct.size} holders without a same-block bundle — the organic shape. (Heuristic from the first ${rows.length} transfers.)`,
    note: "Reads a token's earliest transfers (CDP SQL) to spot a sniped/bundled launch: many recipients in one early block, or a tight early block span, or very few early holders. A heuristic launch-quality signal pairing with b20-launch-radar — not proof. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// contract-owner — who controls this contract right now (pure on-chain)
// ---------------------------------------------------------------------------

const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
// EIP-1967 slots
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const slotAddr = (w: string | null | undefined) => (w && w.length >= 42 ? getAddress("0x" + w.slice(-40)) : null);

export async function contractOwner(params: Record<string, string>) {
  const addrRaw = (params.address || params.contract || "").trim();
  if (!validAddr(addrRaw)) throw new Error("Provide a contract address (address=0x…)");
  const addr = getAddress(addrRaw) as Address;

  const code = await client.getBytecode({ address: addr }).catch(() => null);
  if (code === null) throw new Error("Could not read the chain (RPC) — not charged, retry shortly");
  if (code === "0x" || !code) return { address: addr, isContract: false, verdict: "not_a_contract", note: "No bytecode at this address — it is a wallet, not a contract.", checkedAt: new Date().toISOString() };

  const call = async (fn: "owner" | "getOwner" | "admin" | "pendingOwner" | "paused") => {
    try { return await client.readContract({ address: addr, abi: OWNER_ABI, functionName: fn }); } catch { return null; }
  };
  const [owner, getOwner, admin, pendingOwner, paused] = await Promise.all([call("owner"), call("getOwner"), call("admin"), call("pendingOwner"), call("paused")]);
  const [implSlot, adminSlot] = await Promise.all([
    client.getStorageAt({ address: addr, slot: SLOT_IMPL }).catch(() => null),
    client.getStorageAt({ address: addr, slot: SLOT_ADMIN }).catch(() => null),
  ]);
  const proxyImpl = slotAddr(implSlot);
  const proxyAdmin = slotAddr(adminSlot);
  const effectiveOwner = (owner as string) || (getOwner as string) || (admin as string) || null;

  const ownerIsContract = effectiveOwner && effectiveOwner !== ZERO
    ? await client.getBytecode({ address: effectiveOwner as Address }).then((c) => Boolean(c && c !== "0x")).catch(() => null)
    : null;
  const renounced = effectiveOwner != null && effectiveOwner.toLowerCase() === ZERO;
  const upgradeable = proxyImpl != null && proxyImpl !== ZERO;

  const verdict = renounced ? "ownership_renounced"
    : upgradeable && proxyAdmin && proxyAdmin !== ZERO ? "upgradeable_admin_controlled"
      : effectiveOwner ? (ownerIsContract ? "owner_is_contract" : "owner_is_eoa")
        : "no_owner_surface";

  return {
    address: addr,
    isContract: true,
    owner: effectiveOwner,
    ownerType: effectiveOwner && effectiveOwner !== ZERO ? (ownerIsContract === null ? "unknown" : ownerIsContract ? "contract (multisig/timelock?)" : "EOA (single key)") : null,
    pendingOwner: pendingOwner && (pendingOwner as string) !== ZERO ? pendingOwner : null,
    renounced,
    upgradeable,
    proxyImplementation: upgradeable ? proxyImpl : null,
    proxyAdmin: proxyAdmin && proxyAdmin !== ZERO ? proxyAdmin : null,
    paused: typeof paused === "boolean" ? paused : null,
    verdict,
    recommendation:
      renounced ? "Ownership renounced (owner = 0x0) — no privileged owner can act. Upgradeability/proxy-admin may still apply; check proxyAdmin."
        : verdict === "upgradeable_admin_controlled" ? `⚠️ Upgradeable proxy — a proxy admin (${proxyAdmin}) can swap the logic behind this address at any block. Trust is only as good as that admin.`
          : verdict === "owner_is_eoa" ? `Controlled by a SINGLE EOA key (${effectiveOwner}) — one compromised key is total control. Prefer a multisig/timelock.`
            : verdict === "owner_is_contract" ? `Owner is a contract (${effectiveOwner}) — likely a multisig or timelock; verify which before trusting.`
              : "No standard owner/admin surface found — control may be via roles (try b20-control for B20) or a custom scheme.",
    note: "Reads who controls a contract right now, straight from chain: owner/getOwner/admin, pending owner, EIP-1967 proxy implementation + admin, and paused state. Ownership renounced ≠ safe if it is still an upgradeable proxy. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
