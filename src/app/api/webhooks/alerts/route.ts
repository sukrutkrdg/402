import { NextResponse } from "next/server";
import { registerSecurityWebhook, sendWebhookPing, SecurityAlertType } from "@/lib/security-alerts";

export async function GET() {
  return NextResponse.json({
    service: "x402-bazaar-security-alerts",
    description: "Webhook alert push engine for autonomous agents & DeFi bots on Base",
    supportedAlertTypes: [
      {
        type: "HONEYPOT_DETECTED",
        description: "Fires when a token's sell tax spikes or trading is blocked at the contract level",
      },
      {
        type: "B20_SEIZURE_ACTIVATED",
        description: "Fires when a B20 asset or token turns seizable (burnBlocked) or policy changes",
      },
      {
        type: "WHALE_DUMP_RISK",
        description: "Fires when top wallet concentration or exit liquidity risk exceeds 70%",
      },
      {
        type: "CLANKER_IMPERSONATOR",
        description: "Fires when a fake impersonator contract clones an official Clanker token",
      },
    ],
    security: {
      signatureHeader: "X-Bazaar-Signature",
      algorithm: "HMAC-SHA256 (hex)",
      ssrfProtected: true,
      maxDeliveryTimeoutMs: 5000,
    },
    registration: {
      method: "POST",
      endpoint: "/api/webhooks/alerts",
      exampleBody: {
        webhookUrl: "https://your-agent.com/webhook/alerts",
        alertType: "HONEYPOT_DETECTED",
        tokenAddress: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
        testPing: true,
      },
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const webhookUrl = String(body.webhookUrl || "").trim();
    const alertType = String(body.alertType || "").trim() as SecurityAlertType;
    const tokenAddress = body.tokenAddress ? String(body.tokenAddress).trim() : undefined;
    const testPing = Boolean(body.testPing);

    if (!webhookUrl) {
      return NextResponse.json({ error: "Missing webhookUrl parameter" }, { status: 400 });
    }
    if (!alertType) {
      return NextResponse.json({ error: "Missing alertType parameter" }, { status: 400 });
    }

    const sub = await registerSecurityWebhook({
      webhookUrl,
      alertType,
      tokenAddress,
    });

    let pingResult = null;
    if (testPing) {
      pingResult = await sendWebhookPing(sub);
    }

    return NextResponse.json({
      success: true,
      subscriptionId: sub.id,
      webhookUrl: sub.webhookUrl,
      alertType: sub.alertType,
      tokenAddress: sub.tokenAddress ?? "all",
      secret: sub.secret,
      signatureHeader: "X-Bazaar-Signature (sha256=<hmac>)",
      testPing: pingResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook registration failed";
    const status = /ssrf|private|internal|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
