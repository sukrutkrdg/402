/**
 * Validity Transaction builder — make ANY Base transaction conditional (Cobalt).
 *
 * base-swap-validity wraps a 0x swap. This is the general case: an agent that has
 * already built and SIGNED any transaction — a transfer, an approve, a contract
 * call — gets back the ready-to-submit `base_sendRawTransactionValidity` request
 * that holds it dormant until its conditions hold. No swap, no 0x, no funds or
 * keys touched by us: we validate the predicates (the error-prone part) and
 * assemble the JSON-RPC envelope.
 *
 * The predicate builder, operator whitelist and hex encoding are shared with
 * base-swap-validity (buildValidityPredicates), so the two cannot drift. A price
 * condition is the same caller-supplied storage predicate: a predicate reads a
 * raw slot and cannot call a view function, and slot layouts differ by pool, so
 * the caller supplies the slot and we validate and forward it.
 */

import "server-only";
import { buildValidityPredicates, sequencerEndpoint } from "./base-swap-validity";

/** A signed, serialized tx is 0x + an even number of hex chars. We do not decode
 *  or re-sign it — it is the caller's, passed straight through to the envelope. */
function normalizeSignedTx(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (!/^0x[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) {
    throw new Error("signedTx must be a 0x-prefixed signed serialized transaction (even-length hex). Omit it to get the envelope with a placeholder.");
  }
  return s.toLowerCase();
}

export async function validityBuild(params: Record<string, string>) {
  // Validate conditions FIRST — a malformed predicate must fail before anything
  // else, so a bad condition is never charged.
  const validity = buildValidityPredicates(params);
  const signedTx = normalizeSignedTx(params.signedTx || params.rawTx || params.signedRawTransaction);
  const endpoint = sequencerEndpoint();

  const txField = signedTx ?? "0x<SIGNED_RAW_TRANSACTION>";
  const rpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "base_sendRawTransactionValidity",
    params: [txField, { validity }],
  };

  const deadline = validity.find((v) => v.type === "block_number" && v.params.op === "<");

  return {
    chain: "base" as const,
    conditional: true,
    conditionCount: validity.length,
    validity,
    submit: { method: "base_sendRawTransactionValidity", endpoint, rpcRequest },
    signedTxProvided: signedTx !== null,
    steps: [
      signedTx
        ? "Your signed transaction is embedded below — do NOT also broadcast it with eth_sendRawTransaction."
        : "Sign your transaction (EIP-1559 recommended), then replace 0x<SIGNED_RAW_TRANSACTION> in the request below with the signed serialized tx. Do NOT broadcast it normally.",
      `POST the JSON-RPC request to Base's sequencer (${endpoint}). The response is the 32-byte tx hash.`,
      deadline
        ? "Base holds it until every condition holds, then includes it. If the deadline block arrives first it is never included — no stuck order to cancel."
        : "Base holds it until every condition holds, then includes it. Add a beforeBlock deadline so an unmet condition cannot leave it pending indefinitely.",
    ],
    priceConditionNote:
      "A 'price ≥ X' condition is a storage predicate on your pool's slot — supplied by you, because a predicate reads a raw slot and cannot call a view function, and slot layouts differ by pool. We validate and forward it; we do not derive a slot from a price.",
    note: "Wrap any signed Base transaction in a Cobalt validity transaction — a good-till-block/conditional order with no limit-order contract and nobody holding the trade. We never hold funds or keys. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
