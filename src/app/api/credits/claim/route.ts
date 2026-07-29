/**
 * Claim the credit token for a paid Stripe Checkout session.
 *
 * Minting happens HERE, not in the webhook, and only after asking Stripe
 * directly whether the session is paid — so a forged session id buys nothing,
 * and no code path can mint from client-supplied data.
 *
 * DELIVERY vs. SECRECY: credits.ts deliberately stores only a hash of the token,
 * because a KV leak must never yield spendable balances. Card checkout breaks
 * that symmetry: the buyer is redirected back through a browser, and if the
 * response is lost (tab closed, network drop, mobile redirect eaten) they have
 * paid and hold nothing. So the minted token is cached in plaintext under the
 * session id for 24h, letting a retry return the SAME token instead of charging
 * again. The session id is high-entropy and known only to Stripe and the buyer;
 * after 24h the plaintext is gone and only the hash remains. Losing a customer's
 * money is the worse failure, so this window is intentional.
 */

import { NextRequest, NextResponse } from "next/server";
import { buyCredits } from "@/lib/credits";
import { retrieveSession, stripeConfig } from "@/lib/stripe";
import { kvGet, kvSet, kvSetNx, kvDel } from "@/lib/kv";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TOKEN_TTL = 60 * 60 * 24; // 24h retry window for a lost response
const tokenKey = (id: string) => `stripe:tok:${id}`;
const mintKey = (id: string) => `stripe:minted:${id}`;

export async function GET(req: NextRequest) {
  const cfg = stripeConfig();
  if (!cfg) return NextResponse.json({ error: "Card checkout is not enabled." }, { status: 503 });

  const id = (new URL(req.url).searchParams.get("session_id") || "").trim();
  // Stripe session ids look like cs_test_… / cs_live_… — reject anything else
  // before it reaches the API or a KV key.
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) {
    return NextResponse.json({ error: "Pass a valid session_id." }, { status: 400 });
  }

  // Guessing session ids is infeasible, but rate-limit anyway so nobody can use
  // this endpoint to probe Stripe on our key.
  const rl = await rateLimitKv(`stripe:claim:${clientIp(req)}`, 20, 300);
  if (!rl.ok) {
    return NextResponse.json({ error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` }, { status: 429 });
  }

  // Already minted and still inside the retry window → hand back the same token.
  const cached = await kvGet(tokenKey(id));
  if (cached) {
    return NextResponse.json({ ...JSON.parse(cached), replay: true });
  }

  let session;
  try {
    session = await retrieveSession(cfg, id);
  } catch {
    return NextResponse.json({ error: "Unknown checkout session." }, { status: 404 });
  }
  if (session.payment_status !== "paid") {
    return NextResponse.json(
      { error: "This checkout is not paid yet.", paymentStatus: session.payment_status ?? "unknown" },
      { status: 402 },
    );
  }
  if (session.metadata?.product !== "x402-bazaar-credits") {
    return NextResponse.json({ error: "This session is not a credit purchase." }, { status: 400 });
  }

  // Exactly-once mint per session. kvSetNx is the atomic gate: whoever sets it
  // first mints, and a concurrent second request falls through to the cached
  // token instead of minting a second balance for one payment.
  const first = await kvSetNx(mintKey(id), 60 * 60 * 24 * 180);
  if (!first) {
    const again = await kvGet(tokenKey(id));
    if (again) return NextResponse.json({ ...JSON.parse(again), replay: true });
    return NextResponse.json(
      {
        error:
          "This purchase was already claimed and the one-time token is no longer retrievable. Contact support with the session id if you never received it.",
        sessionId: id,
      },
      { status: 409 },
    );
  }

  // The tier comes from the session metadata we set server-side at creation, so
  // the amount credited always matches the amount Stripe actually charged.
  const tier = session.metadata?.tier ?? "";
  let minted;
  try {
    minted = await buyCredits({ tier });
  } catch (e) {
    // Mint failed (e.g. KV write). Release the gate so the buyer can retry
    // rather than being locked out of credit they have paid for.
    await kvDel(mintKey(id));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not mint credits — retry shortly." },
      { status: 503 },
    );
  }

  const payload = { ...minted, paidVia: "card", sessionId: id };
  await kvSet(tokenKey(id), JSON.stringify(payload), TOKEN_TTL);
  return NextResponse.json(payload);
}
