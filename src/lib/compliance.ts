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

// Maintained mirror of OFAC-sanctioned ETH-format addresses (applies to Base too,
// since addresses share the EVM address space).
const LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { set: Set<string>; size: number; fetchedAt: number } | null = null;

async function loadList(): Promise<{ set: Set<string>; size: number }> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
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
    if (set.size === 0) throw new Error("empty list");
    cache = { set, size: set.size, fetchedAt: Date.now() };
    return cache;
  } catch (err) {
    if (cache) return cache; // serve stale rather than fail
    throw new Error(`Sanctions list unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sanctionsCheck(params: Record<string, string>) {
  const raw = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("Provide a valid 0x… address");
  const address = getAddress(raw);

  const { set, size } = await loadList();
  const sanctioned = set.has(address.toLowerCase());

  return {
    address,
    sanctioned,
    matchType: sanctioned ? "direct" : "none",
    source: "OFAC SDN — sanctioned digital currency addresses",
    listSize: size,
    note: sanctioned
      ? "Address is on the OFAC sanctions list — do not transact."
      : "No direct match on the OFAC list (direct-address match only; does not trace indirect exposure).",
    checkedAt: new Date().toISOString(),
  };
}
