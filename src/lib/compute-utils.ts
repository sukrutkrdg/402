/**
 * Commodity compute utilities — the high-volume calls the whole x402 ecosystem
 * hammers, served at sub-cent cost.
 *
 * A systematic x402 crawler we observed pays HUNDREDS of times each to hashing
 * endpoints (506×+144×), unit converters (144×) and "always-returns" purchase-test
 * endpoints (452×) across dozens of sellers — the commodity utilities are the most
 * bought thing on the network. They cost us nothing to run (pure compute, no RPC,
 * no upstream), so we offer our own at the sub-cent floor to capture that volume.
 *
 * All three are deterministic and never touch the chain or an API.
 */

import "server-only";
import { keccak256, sha256, toHex, stringToHex, parseUnits, formatUnits, isHex } from "viem";

/** hash — keccak256 / sha256 of text or hex input. */
export async function hashUtil(params: Record<string, string>) {
  const input = (params.input ?? params.data ?? params.text ?? "").toString();
  if (input.length === 0) throw new Error("Provide input to hash (input=…). Text, or 0x-hex for raw bytes.");
  const algo = (params.algo || "keccak256").toLowerCase();
  if (!["keccak256", "sha256"].includes(algo)) throw new Error("algo must be keccak256 or sha256");
  // Treat 0x-prefixed even-length hex as raw bytes; everything else as UTF-8 text.
  const bytes = isHex(input) ? (input as `0x${string}`) : stringToHex(input);
  const digest = algo === "sha256" ? sha256(bytes) : keccak256(bytes);
  return {
    algo,
    inputInterpretedAs: isHex(input) ? "hex bytes" : "utf-8 text",
    inputBytes: (bytes.length - 2) / 2,
    hash: digest,
    selector: algo === "keccak256" ? digest.slice(0, 10) : undefined, // 4-byte fn selector, when useful
    note: "Deterministic hash of the input. keccak256 is the EVM/Solidity hash (event topics, function selectors, mapping keys); sha256 is the general one. Pass 0x-hex to hash raw bytes, otherwise it hashes the UTF-8 text.",
    checkedAt: new Date().toISOString(),
  };
}

const UNITS: Record<string, number> = { wei: 0, kwei: 3, mwei: 6, gwei: 9, szabo: 12, finney: 15, ether: 18, eth: 18 };

/** unit-convert — wei/gwei/ether or any decimals, both directions. */
export async function unitConvert(params: Record<string, string>) {
  const amount = (params.amount ?? params.value ?? "").toString().trim();
  if (!amount) throw new Error("Provide amount (amount=1.5)");
  const from = (params.from || "ether").toLowerCase();
  const to = (params.to || "wei").toLowerCase();
  // Resolve a unit name OR a raw decimals integer ("6" for USDC-style tokens).
  const dec = (u: string): number => {
    if (u in UNITS) return UNITS[u];
    if (/^\d+$/.test(u)) return Number(u);
    throw new Error(`Unknown unit "${u}". Use wei/kwei/mwei/gwei/szabo/finney/ether, or a decimals number (e.g. 6 for USDC).`);
  };
  const fromDec = dec(from);
  const toDec = dec(to);
  let base: bigint; // value in wei-equivalent (smallest unit at fromDec)
  try {
    base = parseUnits(amount, fromDec);
  } catch {
    throw new Error(`amount must be a number in ${from} units`);
  }
  // Re-scale from fromDec to toDec.
  const out = toDec >= fromDec ? formatUnits(base * 10n ** BigInt(toDec - fromDec), toDec) : formatUnits(base / 10n ** BigInt(fromDec - toDec), toDec);
  return {
    amount,
    from,
    to,
    fromDecimals: fromDec,
    toDecimals: toDec,
    result: out,
    baseUnits: base.toString(),
    note: "Convert between wei/gwei/ether (or any token decimals — pass the decimals number). Integer-exact; no precision loss. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}

/** ping — an always-returns health/echo endpoint (the x402 purchase-test pattern). */
export async function ping(params: Record<string, string>) {
  return {
    ok: true,
    service: "402.com.tr",
    echo: params.echo ?? params.msg ?? null,
    ts: Date.now(),
    note: "Always-returns x402 health check: the cheapest possible end-to-end purchase test. Use it to verify your x402 client, payment path and our settlement in one call.",
    checkedAt: new Date().toISOString(),
  };
}
