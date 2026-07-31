/**
 * Read a prepaid balance without spending it.
 *
 * A prepaid product whose holder can only discover the balance by trying to buy
 * something is incomplete: the customer finds out they are empty at the moment
 * they needed the call to work. The mint response advertises this endpoint, and
 * the same header that spends the balance reads it.
 *
 * The token stays in the HEADER. Accepting it in the query string would write a
 * spendable bearer key into every access log and referer along the way — the
 * same rule the owner-only stats endpoint follows.
 */

import { NextRequest, NextResponse } from "next/server";
import { creditStatus } from "@/lib/credits";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // A balance read is cheap, but it is also an oracle for guessing tokens, so it
  // gets the same per-IP ceiling as the paid gateway.
  const rl = await rateLimitKv(`creditbal:${clientIp(req)}`, 60, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const token = req.headers.get("x-credit-token") || "";
  if (!token) {
    return NextResponse.json(
      { error: "Send your credit token in the `x-credit-token` header (never in the query string — it would end up in logs)." },
      { status: 400 },
    );
  }

  const { cents, expiresInDays } = await creditStatus(token);
  // An unknown token and a spent one are deliberately indistinguishable: both
  // are simply "no balance", so this cannot be used to test whether a guessed
  // token exists.
  return NextResponse.json(
    {
      balanceUsd: +(cents / 100).toFixed(2),
      balanceCents: cents,
      expiresInDays,
      spendable: cents > 0,
      howToSpend:
        "Send the same `x-credit-token` header on any paid service call; the price is debited from this balance and the remainder comes back in the `x-credit-balance` header.",
      topUp: "Buying again mints a separate token. To merge balances into one token, recover from the wallet that paid: POST /api/credits/recover.",
    },
    { headers: { "x-credit-balance": String(cents), "cache-control": "no-store" } },
  );
}
