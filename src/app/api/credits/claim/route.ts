/**
 * Claim the credit token for a paid Polar checkout.
 *
 * Minting happens HERE, not in the webhook, and only after asking Polar directly
 * whether the checkout succeeded — so a forged id buys nothing, and no code path
 * can mint from client-supplied data. The credited amount is read from Polar's
 * own record of what was paid (`net_amount`), never from our metadata or the
 * query string, so the balance can only ever match real money received.
 *
 * DELIVERY vs. SECRECY: credits.ts deliberately stores only a hash of the token,
 * because a KV leak must never yield spendable balances. Card checkout breaks
 * that symmetry: the buyer is redirected back through a browser, and if the
 * response is lost (tab closed, network drop, mobile redirect eaten) they have
 * paid and hold nothing. So the minted token is cached in plaintext under the
 * checkout id for 24h, letting a retry return the SAME token instead of charging
 * again. The id is a uuid known only to Polar and the buyer; after 24h the
 * plaintext is gone and only the hash remains. Losing a customer's money is the
 * worse failure, so this window is intentional.
 */

import { NextRequest, NextResponse } from "next/server";
import { mintCredits, CARD_PACKS } from "@/lib/credits";
import { retrieveCheckout, polarConfig } from "@/lib/polar";
import { kvGet, kvSet, kvSetNx, kvDel } from "@/lib/kv";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TOKEN_TTL = 60 * 60 * 24; // 24h retry window for a lost response
const tokenKey = (id: string) => `card:tok:${id}`;
const mintKey = (id: string) => `card:minted:${id}`;

// Guard rails on what a single checkout may mint, in cents. A misconfigured
// product (or a Polar-side change to the amount fields) should fail loudly
// rather than quietly hand out a balance nobody paid for.
const MIN_CENTS = Math.min(...Object.values(CARD_PACKS).map((p) => p.credits));
const MAX_CENTS = Math.max(...Object.values(CARD_PACKS).map((p) => p.credits));

export async function GET(req: NextRequest) {
  const cfg = polarConfig();
  if (!cfg) return NextResponse.json({ error: "Card checkout is not enabled." }, { status: 503 });

  const url = new URL(req.url);
  const id = (url.searchParams.get("checkout_id") || url.searchParams.get("session_id") || "").trim();
  // Polar checkout ids are uuid4 — reject anything else before it reaches the
  // API or becomes a KV key.
  if (!/^[0-9a-fA-F-]{32,40}$/.test(id)) {
    return NextResponse.json({ error: "Pass a valid checkout_id." }, { status: 400 });
  }

  // Guessing ids is infeasible, but rate-limit anyway so nobody can use this
  // endpoint to probe Polar on our token.
  const rl = await rateLimitKv(`card:claim:${clientIp(req)}`, 20, 300);
  if (!rl.ok) {
    return NextResponse.json({ error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` }, { status: 429 });
  }

  // Already minted and still inside the retry window → hand back the same token.
  const cached = await kvGet(tokenKey(id));
  if (cached) return NextResponse.json({ ...JSON.parse(cached), replay: true });

  let checkout;
  try {
    checkout = await retrieveCheckout(cfg, id);
  } catch {
    return NextResponse.json({ error: "Unknown checkout." }, { status: 404 });
  }
  if (checkout.status !== "succeeded") {
    return NextResponse.json(
      { error: "This checkout is not paid yet.", status: checkout.status },
      { status: 402 },
    );
  }
  if ((checkout.currency ?? "usd").toLowerCase() !== "usd") {
    return NextResponse.json({ error: "Only USD checkouts mint credit." }, { status: 400 });
  }

  // Credit 1:1 with what was actually paid, before tax (tax goes to the state,
  // not to us). Falling back through the amount fields keeps this working if a
  // discount or tax field is absent.
  const cents = checkout.net_amount ?? checkout.amount ?? 0;
  if (!Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) {
    return NextResponse.json(
      { error: "Paid amount is outside the supported range for credit.", paidCents: cents },
      { status: 409 },
    );
  }

  // Exactly-once mint per checkout. kvSetNx is the atomic gate: whoever sets it
  // first mints, and a concurrent second request falls through to the cached
  // token instead of minting a second balance for one payment.
  const first = await kvSetNx(mintKey(id), 60 * 60 * 24 * 180);
  if (!first) {
    const again = await kvGet(tokenKey(id));
    if (again) return NextResponse.json({ ...JSON.parse(again), replay: true });
    return NextResponse.json(
      {
        error:
          "This purchase was already claimed and the one-time token is no longer retrievable. Contact support with the checkout id if you never received it.",
        checkoutId: id,
      },
      { status: 409 },
    );
  }

  let minted;
  try {
    minted = await mintCredits(cents, cents / 100);
  } catch (e) {
    // Mint failed (e.g. KV write). Release the gate so the buyer can retry
    // rather than being locked out of credit they have paid for.
    await kvDel(mintKey(id));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not mint credits — retry shortly." },
      { status: 503 },
    );
  }

  const payload = { ...minted, paidVia: "card", checkoutId: id };
  await kvSet(tokenKey(id), JSON.stringify(payload), TOKEN_TTL);
  return NextResponse.json(payload);
}
