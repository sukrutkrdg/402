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

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { serviceId?: string; params?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const service = getService(body.serviceId || "");
  if (!service) {
    return NextResponse.json({ error: "Unknown service" }, { status: 404 });
  }

  const cfg = getConfig();
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

  // Settlement details live in the X-PAYMENT-RESPONSE header.
  let txHash = "";
  let network = "";
  let payer: string | undefined;
  const settleHeader = res.headers.get("x-payment-response");
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
