/**
 * A note to the caller who came back.
 *
 * We have no way to reach the people running these agents. There is no email on
 * a wallet, and the two buyers worth talking to are hex strings that pay us and
 * disappear. The one channel that reliably reaches them is the one they already
 * read: the response body. Agents parse it — the `upgrade` hint added in July
 * demonstrably got followed.
 *
 * That makes this easy to get wrong. A marketing line in a paid response is
 * noise the caller is paying for, and an agent that learns our payloads carry
 * filler starts skipping fields that matter. So:
 *
 *   - It appears only after several paid calls. A first-time caller sees nothing.
 *   - It appears ONCE, ever, per wallet. Not once per service, not once a week.
 *   - Everything in it is worth money TO THEM: the credit path removes a
 *     signature per call, the batch endpoint removes N-1 calls entirely. We are
 *     telling a repeat customer how to pay us less per unit, which is the only
 *     version of this that is honest.
 *   - It never blocks or breaks a paid response.
 */

import "server-only";
import { kvGet, kvSet } from "./kv";
import { getPayerServices } from "./usage";

/** Calls before we say anything. Low enough to catch a real workflow, high
 *  enough that a crawler sweeping the network never trips it. */
const AFTER_CALLS = 3;
/** One note per wallet, effectively forever. */
const NOTED_TTL = 60 * 60 * 24 * 365;

/** Services that answer the same question for many inputs in one paid call. */
const BATCH_ALTERNATIVE: Record<string, { id: string; saves: string }> = {
  "token-risk": { id: "batch-risk", saves: "score up to 20 tokens in one call" },
  "rug-score": { id: "batch-risk", saves: "score up to 20 tokens in one call" },
  "b20-safety": { id: "b20-batch", saves: "check up to 5 B20 tokens in one call" },
  "b20-info": { id: "b20-batch", saves: "check up to 5 B20 tokens in one call" },
  sanctions: { id: "sanctions-batch", saves: "screen many addresses in one call" },
  "safe-to-send": { id: "sanctions-batch", saves: "screen many addresses in one call" },
  "token-price": { id: "multi-price", saves: "price many tokens in one call" },
  "ai-extract": { id: "ai-extract-batch", saves: "extract from 10 documents in one call" },
};

export interface ReturningCallerNote {
  callsSoFar: number;
  cheaper: string;
  batch?: string;
  contact: string;
  note: string;
}

/**
 * A one-time note for a wallet that keeps coming back, or null.
 *
 * `payerHash` is the same hashed-payer key the usage log records, so this reads
 * a counter that already exists rather than adding one.
 */
export async function returningCallerNote(serviceId: string, payerHash: string, origin: string): Promise<ReturningCallerNote | null> {
  if (!payerHash) return null;
  try {
    const seenKey = `notified:${payerHash}`;
    if (await kvGet(seenKey)) return null;

    const tally = await getPayerServices(payerHash);
    const total = Object.values(tally).reduce((n, v) => n + v, 0);
    if (total < AFTER_CALLS) return null;

    // Claim it before returning, so two concurrent calls cannot both attach it.
    await kvSet(seenKey, "1", NOTED_TTL);

    const batch = BATCH_ALTERNATIVE[serviceId];
    return {
      callsSoFar: total,
      cheaper: `One settlement on ${origin}/api/x402/buy-credits?tier=1 mints a bearer token; send it as \`x-credit-token\` and later calls debit the balance with no wallet signature per call.`,
      ...(batch ? { batch: `${origin}/api/x402/${batch.id} — ${batch.saves}, one payment instead of one per input.` } : {}),
      contact: "Building something that needs this at volume, or missing a check we do not sell yet? sukrutkrdg@gmail.com — a bulk tier or a new endpoint is a conversation, not a form.",
      note: "Shown once, because you have paid for several calls. It will not appear again.",
    };
  } catch {
    return null; // never let this affect a paid response
  }
}
