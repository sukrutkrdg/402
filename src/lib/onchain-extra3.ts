/**
 * Additional on-chain utility services for the x402 Bazaar — batch 3.
 *
 * Two complementary endpoints powered by free, key-less public APIs:
 *
 *   contractAbi    — check Sourcify verification status and retrieve the ABI
 *                    for any Base contract, returned as function/event name
 *                    lists + item count (no full JSON blob).
 *   decodeSelector — resolve a 4-byte function selector to candidate human-
 *                    readable signatures via 4byte.directory.
 *
 * No upstream API keys required.
 */

import "server-only";
import { getAddress, type Address } from "viem";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Validates a checksummed 0x…40-hex address; throws a user-facing message on failure. */
function requireAddress(raw: string): Address {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… address");
  return getAddress(v);
}

// ---------------------------------------------------------------------------
// 1. contractAbi — Sourcify verification + ABI for a Base contract
// ---------------------------------------------------------------------------

interface SourcifyCheckEntry {
  address?: string;
  chainIds?: Array<{ chainId: string; status: string }>;
  status?: string | boolean;
}

interface SourcifyMetadata {
  output?: {
    abi?: Array<{ type: string; name?: string; [key: string]: unknown }>;
  };
}

/**
 * Checks whether a Base contract is verified on Sourcify and, if so, returns
 * its ABI as function/event name lists plus a total item count.
 *
 * Verification check: `https://sourcify.dev/server/check-by-addresses`
 * Metadata fetch:     `https://repo.sourcify.dev/contracts/{match}/8453/{address}/metadata.json`
 *
 * A non-verified contract returns a valid (paid) response — only an invalid
 * address or a total network failure on the check call will throw.
 *
 * @param params.address — Base contract address (required, checksummed 0x…40-hex).
 */
export async function contractAbi(params: Record<string, string>) {
  const address = requireAddress(params.address || "");

  // --- Step 1: check verification status ---
  let checkData: SourcifyCheckEntry[];
  try {
    const res = await fetch(
      `https://sourcify.dev/server/check-by-addresses?addresses=${address}&chainIds=8453`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`Sourcify check responded ${res.status}`);
    checkData = (await res.json()) as SourcifyCheckEntry[];
  } catch (err) {
    throw new Error(
      `Sourcify verification check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse the status from the response array.
  const entry = Array.isArray(checkData) ? checkData[0] : null;
  const chainEntry = entry?.chainIds?.find((c) => c.chainId === "8453");
  const status = chainEntry?.status; // "perfect" | "partial" | undefined/false

  const verified = status === "perfect" || status === "partial";
  const matchType: "full" | "partial" | null =
    status === "perfect" ? "full" : status === "partial" ? "partial" : null;

  if (!verified) {
    return {
      address,
      verified: false,
      matchType: null,
      functions: [] as string[],
      events: [] as string[],
      abiItemCount: 0,
      checkedAt: new Date().toISOString(),
    };
  }

  // --- Step 2: fetch metadata to obtain the ABI ---
  // Try full_match first (exact byte-for-byte), fall back to partial_match.
  const matchPaths =
    matchType === "full"
      ? ["full_match", "partial_match"]
      : ["partial_match", "full_match"];

  let abi: Array<{ type: string; name?: string }> = [];
  for (const match of matchPaths) {
    try {
      const res = await fetch(
        `https://repo.sourcify.dev/contracts/${match}/8453/${address}/metadata.json`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const meta = (await res.json()) as SourcifyMetadata;
      if (Array.isArray(meta?.output?.abi)) {
        abi = meta.output.abi as Array<{ type: string; name?: string }>;
        break;
      }
    } catch {
      // Try next match type.
    }
  }

  const functions = abi
    .filter((item) => item.type === "function" && item.name)
    .map((item) => item.name as string);

  const events = abi
    .filter((item) => item.type === "event" && item.name)
    .map((item) => item.name as string);

  return {
    address,
    verified,
    matchType,
    functions,
    events,
    abiItemCount: abi.length,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 2. decodeSelector — resolve a 4-byte selector via 4byte.directory
// ---------------------------------------------------------------------------

interface FourByteResult {
  text_signature: string;
  created_at: string;
}

interface FourByteResponse {
  results?: FourByteResult[];
}

/**
 * Resolves a 4-byte Ethereum function selector to one or more candidate
 * human-readable signatures using the free 4byte.directory public API.
 *
 * Accepts either:
 *   - a bare 4-byte selector: `0x70a08231`
 *   - full calldata (only the first 10 characters are used): `0x70a08231…`
 *
 * Results are sorted oldest-first (most likely to be the canonical signature).
 * Zero matches is a valid (paid) response — only an invalid selector or a
 * network failure will throw.
 *
 * @param params.selector — 4-byte selector or calldata prefix (required).
 */
export async function decodeSelector(params: Record<string, string>) {
  const raw = (params.selector || "").trim();

  // Normalize: accept full calldata but only keep the first 10 chars (0x + 8 hex).
  const normalized = raw.length > 10 ? raw.slice(0, 10) : raw;

  if (!/^0x[0-9a-fA-F]{8}$/.test(normalized)) {
    throw new Error("Provide a 4-byte selector like 0x70a08231");
  }

  const selector = normalized.toLowerCase() as `0x${string}`;

  let data: FourByteResponse;
  try {
    const res = await fetch(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`4byte.directory responded ${res.status}`);
    data = (await res.json()) as FourByteResponse;
  } catch (err) {
    throw new Error(
      `4byte lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const results = Array.isArray(data.results) ? data.results : [];

  // Sort oldest-first — the earliest registered signature is the most likely
  // canonical one (later entries are often hash collisions).
  results.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const signatures = results.slice(0, 10).map((r) => r.text_signature);

  return {
    selector,
    count: results.length,
    signatures,
    checkedAt: new Date().toISOString(),
  };
}
