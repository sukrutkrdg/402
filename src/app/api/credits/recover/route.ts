/**
 * Recover a lost credit token.
 *
 * WHY THIS EXISTS: the credit token is shown exactly once, and only its hash is
 * stored. That is the right security model — a KV leak must never yield spendable
 * balances — but it meant a buyer who closed the tab before copying had paid for
 * something they could never use, silently, with no way back. Losing a paying
 * customer's money is a worse failure than the one the model was protecting
 * against, so there has to be a door.
 *
 * The door is the wallet that paid. Every purchase indexes the payer's address
 * against the token's hash; proving control of that address here re-issues a
 * single fresh token carrying every remaining cent and invalidates the old ones.
 * The original token is not recoverable (we never had it) — and re-issuing is
 * strictly safer anyway: if the lost token had leaked, recovery kills it.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { recoverCredits } from "@/lib/credits";
import { kvConfigured, kvSetNx } from "@/lib/kv";
import { clientIp, rateLimitKv } from "@/lib/rate-limit";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WINDOW_MS = 10 * 60 * 1000; // how stale a signed message may be

/** The exact message the wallet must sign. Readable, because wallets show it. */
export function recoveryMessage(address: string, issuedAt: string): string {
  return [
    "x402 Bazaar — recover credit balance",
    "",
    `Address: ${address.toLowerCase()}`,
    `Issued: ${issuedAt}`,
    "",
    "Signing this re-issues your credit token and moves the remaining balance to it.",
    "Any token issued earlier stops working.",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  if (!kvConfigured()) {
    return NextResponse.json({ error: "Credits are unavailable (no durable store)." }, { status: 503 });
  }

  const rl = await rateLimitKv(`credit:recover:${clientIp(req)}`, 5, 300);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
      { status: 429 },
    );
  }

  let body: { address?: string; issuedAt?: string; signature?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const address = String(body.address ?? "").trim();
  const issuedAt = String(body.issuedAt ?? "").trim();
  const signature = String(body.signature ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Pass the wallet address that paid." }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "Pass a signature." }, { status: 400 });
  }

  // The signed message carries its own timestamp so a captured signature stops
  // working quickly, rather than being a permanent key to the balance.
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > WINDOW_MS) {
    return NextResponse.json(
      { error: "This request expired. Sign again." },
      { status: 400 },
    );
  }

  const message = recoveryMessage(address, issuedAt);
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: "Signature does not match that address." }, { status: 401 });
  }

  // One use per signature: inside the 10-minute window a replay would otherwise
  // let a captured signature re-issue the token again and take the balance.
  const sigId = createHash("sha256").update(signature).digest("hex").slice(0, 32);
  if (!(await kvSetNx(`credit:recover:sig:${sigId}`, 3600))) {
    return NextResponse.json({ error: "This signature was already used. Sign again." }, { status: 409 });
  }

  try {
    const result = await recoverCredits(address);
    if (result.recoveredCents <= 0) {
      return NextResponse.json(
        {
          error:
            "No recoverable balance for this wallet. Credits are indexed from the wallet that paid — if you bought from a different wallet, sign with that one.",
          address: address.toLowerCase(),
        },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ...result.minted,
      recoveredUsd: +(result.recoveredCents / 100).toFixed(2),
      tokensReplaced: result.tokensMerged,
      note: "Any token issued for this wallet before now has stopped working. Save this one.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Recovery failed — nothing was changed." },
      { status: 503 },
    );
  }
}
