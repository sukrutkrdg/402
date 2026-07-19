/**
 * Coinbase Onramp session-token endpoint.
 *
 * Lets a user buy USDC directly onto Base (into their connected wallet) so they
 * can pay for services — the #1 conversion blocker is "no USDC on Base". Since
 * mid-2025 Onramp URLs must be initialized with a session token minted via the
 * CDP API (authenticated with the same CDP key we already use for settlement).
 * Client flow: POST { address } here → get { token } → open
 * pay.coinbase.com/buy?sessionToken=…&defaultAsset=USDC&defaultNetwork=base.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { getConfig } from "@/lib/config";
import { rateLimitKv, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const HOST = "api.developer.coinbase.com";
const PATH = "/onramp/v1/token";

export async function POST(req: NextRequest) {
  const cfg = getConfig();
  if (!cfg.cdpApiKeyId || !cfg.cdpApiKeySecret) {
    return NextResponse.json({ error: "Onramp not configured (set CDP_API_KEY_ID/SECRET)" }, { status: 503 });
  }

  // No auth on this endpoint (it's called from the client before a wallet is
  // funded), so cap per IP — every call mints a CDP JWT and hits the authenticated
  // onramp API, which a loop could otherwise use to drain our CDP quota.
  const ip = clientIp(req);
  const rl = await rateLimitKv(`onramp:${ip}`, 10, 60);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many requests — try again shortly" }, { status: 429 });
  }

  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Valid 0x… wallet address required" }, { status: 400 });
  }

  try {
    const jwt = await generateJwt({
      apiKeyId: cfg.cdpApiKeyId,
      apiKeySecret: cfg.cdpApiKeySecret,
      requestMethod: "POST",
      requestHost: HOST,
      requestPath: PATH,
    });

    const res = await fetch(`https://${HOST}${PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ addresses: [{ address, blockchains: ["base"] }], assets: ["USDC"] }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[onramp] token failed ${res.status}: ${text.slice(0, 300)}`);
      return NextResponse.json({ error: `Onramp token request failed (${res.status})` }, { status: 502 });
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    // CDP has returned the token under a few shapes across versions — accept any.
    const token =
      (json.token as string) ||
      ((json.data as { token?: string })?.token ?? "") ||
      (json.sessionToken as string) ||
      "";
    if (!token) {
      console.error(`[onramp] no token in response: ${text.slice(0, 300)}`);
      return NextResponse.json({ error: "Onramp returned no session token" }, { status: 502 });
    }
    return NextResponse.json({ token });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Onramp error";
    console.error(`[onramp] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
