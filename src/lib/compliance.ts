/**
 * Sanctions / compliance check.
 *
 * Checks an address against the OFAC SDN list of sanctioned digital-currency
 * addresses (maintained, machine-readable mirror of the official OFAC data).
 * Compliance agents and trading bots need this before transacting. The list is
 * cached in-memory (6h) so calls stay cheap; on a fetch failure we serve the
 * cached copy, or throw if we have none (so x402 doesn't charge for no answer).
 *
 * Note: direct-address match only — it does not trace indirect exposure.
 */

import "server-only";
import { getAddress } from "viem";
import { addressIntel, tokenRisk } from "./onchain";

// Maintained mirror of OFAC-sanctioned ETH-format addresses (applies to Base too,
// since addresses share the EVM address space).
const LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { set: Set<string>; size: number; fetchedAt: number } | null = null;

async function loadList(): Promise<{ set: Set<string>; size: number; fetchedAt: number; stale: boolean }> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return { ...cache, stale: false };
  try {
    const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`list responded ${res.status}`);
    const text = await res.text();
    const set = new Set(
      text
        .split("\n")
        .map((l) => l.trim().toLowerCase())
        .filter((l) => /^0x[0-9a-f]{40}$/.test(l)),
    );
    // Sanity: an implausibly small list signals tampering/truncation — don't trust it.
    if (set.size < 10) throw new Error("list implausibly small — possible tampering");
    cache = { set, size: set.size, fetchedAt: Date.now() };
    return { ...cache, stale: false };
  } catch (err) {
    if (cache) return { ...cache, stale: true }; // serve stale (flagged) rather than fail
    throw new Error(`Sanctions list unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sanctionsCheck(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… address");
  const address = getAddress(raw);

  const { set, size, fetchedAt, stale } = await loadList();
  const sanctioned = set.has(address.toLowerCase());

  return {
    address,
    sanctioned,
    matchType: sanctioned ? "direct" : "none",
    source: "OFAC SDN — sanctioned digital currency addresses",
    listSize: size,
    listFetchedAt: new Date(fetchedAt).toISOString(),
    stale,
    note: sanctioned
      ? "Address is on the OFAC sanctions list — do not transact."
      : "No direct match on the OFAC list (direct-address match only; does not trace indirect exposure).",
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Compliance check — combined screening for an address: OFAC sanctions (direct)
 * + address profile + (for contracts) risk flags, with a single recommendation.
 * Built for compliance agents that must vet a counterparty before transacting.
 */
export async function complianceCheck(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… address");
  const address = getAddress(raw);

  const [sancR, intelR] = await Promise.allSettled([
    sanctionsCheck({ address }),
    addressIntel({ address }),
  ]);
  const sancV = sancR.status === "fulfilled" ? sancR.value : null;
  const intelV = intelR.status === "fulfilled" ? (intelR.value as { isContract?: boolean }) : null;
  const sanctioned = sancV ? sancV.sanctioned : null;
  const isContract = intelV?.isContract ?? null;

  let token: { riskLevel: string; riskScore: number; flags: string[] } | null = null;
  if (isContract) {
    try {
      const tr = (await tokenRisk({ address })) as { riskLevel: string; riskScore: number; flags: string[] };
      token = { riskLevel: tr.riskLevel, riskScore: tr.riskScore, flags: tr.flags };
    } catch {
      /* contract risk optional */
    }
  }

  const recommendation =
    sanctioned === true ? "blocked" : token?.riskLevel === "high" ? "review" : "clear";

  return {
    address,
    recommendation,
    sanctioned,
    sanctionsStale: sancV?.stale ?? null,
    addressType: isContract === null ? "unknown" : isContract ? "contract" : "eoa",
    token,
    note: "Direct OFAC screening + address profile + (for contracts) risk flags. Indirect exposure tracing not included.",
    checkedAt: new Date().toISOString(),
  };
}
