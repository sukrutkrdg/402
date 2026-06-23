/**
 * BUYER — pays for a marketplace service and returns the result + onchain proof.
 *
 * Flow:
 *   1. Resolve the service and build its protected URL.
 *   2. Call it with the payment-enabled fetch. On the 402, the SDK creates a
 *      USDC payment (with our client Builder Code `s`) and retries.
 *   3. Decode the `X-PAYMENT-RESPONSE` header to read the settlement tx hash.
 *   4. Log the payment so the dashboard can show attribution.
 */

import { NextRequest, NextResponse } from "next/server";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { getPayingFetch } from "@/lib/x402-client";
import { getService } from "@/lib/services";
import { recordPayment } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cfg = getConfig();

  // 1) Master switch — disable spending entirely on public/showcase deploys.
  if (!cfg.enableBuyer) {
    return NextResponse.json(
      { error: "Buying is disabled on this deployment (view-only showcase)." },
      { status: 403 },
    );
  }

  let body: { serviceId?: string; params?: Record<string, string>; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 2) Optional shared-secret gate so a public URL can't drain the buyer wallet.
  if (cfg.buyAccessToken) {
    const provided = req.headers.get("x-buy-token") || body.token || "";
    if (provided !== cfg.buyAccessToken) {
      return NextResponse.json({ error: "Invalid or missing access token." }, { status: 401 });
    }
  }

  // 3) Per-IP rate limit (best-effort) to blunt spamming of the spend endpoint.
  const rl = rateLimit(`buy:${clientIp(req)}`, 5, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit: try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const service = getService(body.serviceId || "");
  if (!service) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404 });
  }

  const origin = new URL(req.url).origin;
  const target = new URL(`/api/x402/${service.id}`, origin);
  for (const p of service.params) {
    const v = body.params?.[p.name];
    if (v) target.searchParams.set(p.name, v);
  }

  let payingFetch: ReturnType<typeof getPayingFetch>;
  try {
    payingFetch = getPayingFetch();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Buyer misconfigured";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  let res: Response;
  try {
    res = await payingFetch(target.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payment failed";
    return NextResponse.json({ error: `Payment failed: ${message}` }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Upstream returned ${res.status}`, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  const result = await res.json();

  // Settlement details live in the PAYMENT-RESPONSE header (x402 v2 emits it
  // without the legacy `X-` prefix; accept both for safety).
  let txHash = "";
  let network = "";
  let payer: string | undefined;
  const settleHeader =
    res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (settleHeader) {
    try {
      const settle = decodePaymentResponseHeader(settleHeader);
      txHash = settle.transaction;
      network = settle.network;
      payer = settle.payer;
    } catch {
      // leave settlement fields blank if header can't be decoded
    }
  }

  if (txHash) {
    await recordPayment({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      serviceId: service.id,
      serviceName: service.name,
      price: service.price,
      txHash,
      network,
      payer,
      appCode: cfg.appBuilderCode,
      clientCode: cfg.clientBuilderCode,
      createdAt: new Date().toISOString(),
    });
  }

  return NextResponse.json({
    service: service.id,
    result,
    payment: {
      txHash,
      network,
      payer,
      price: service.price,
      appCode: cfg.appBuilderCode,
      clientCode: cfg.clientBuilderCode,
    },
  });
}
