import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface LiveTelemetryEvent {
  id: string;
  type: "settlement" | "arbitrage" | "sentinel" | "workflow" | "heartbeat";
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}

export const SAMPLE_STREAM_EVENTS: LiveTelemetryEvent[] = [
  {
    id: "evt-stl-8812",
    type: "settlement",
    timestamp: new Date().toISOString(),
    source: "EIP-3009 Settler",
    payload: {
      txHash: "0x3a7e4b9f2c1d805e6b4a3c2e1f0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d",
      service: "clanker-audit",
      amountUsdc: 0.05,
      publisherShareUsdc: 0.045,
      payer: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      network: "Base Mainnet (8453)",
      builderCode: "bc_pa0gqlv1",
      latencyMs: 18,
    },
  },
  {
    id: "evt-arb-4019",
    type: "arbitrage",
    timestamp: new Date().toISOString(),
    source: "Arbitrage Radar",
    payload: {
      pair: "DEGEN / WETH",
      dexA: "Aerodrome ($0.0142)",
      dexB: "Uniswap v3 ($0.0148)",
      spreadBps: 422,
      netProfitUsdcEst: 28.5,
      executionRoute: "/api/swap/quote",
    },
  },
  {
    id: "evt-snt-9102",
    type: "sentinel",
    timestamp: new Date().toISOString(),
    source: "Clanker Sentinel",
    payload: {
      token: "0xDEADBEEF0000000000000000000000000000CAFE",
      name: "FakeBaseRewards",
      riskScore: 98,
      verdict: "MALICIOUS_HONEYPOT",
      mitigation: "Blacklisted across all AgentKit facilitators",
    },
  },
  {
    id: "evt-wfl-3301",
    type: "workflow",
    timestamp: new Date().toISOString(),
    source: "Workflow Cloud",
    payload: {
      recipeId: "sniper-guard",
      runId: "run-sg-8841",
      step: "EIP-3009 atomic swap broadcasted",
      status: "COMPLETED",
      costUsdc: 0.15,
    },
  },
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  const acceptHeader = req.headers.get("accept") || "";

  // If requested as JSON (polling fallback or test mode), return structured JSON
  if (mode === "poll" || (!acceptHeader.includes("text/event-stream") && acceptHeader.includes("application/json"))) {
    return NextResponse.json({
      status: "ok",
      stream: "x402-live-telemetry",
      builderCode: "bc_pa0gqlv1",
      events: SAMPLE_STREAM_EVENTS,
      telemetry: {
        totalSettled24hUsdc: 184920,
        activeStreams: 142,
        baseTps: 84.6,
        baseGasGwei: 0.0018,
      },
    }, {
      headers: {
        "x-builder-code": "bc_pa0gqlv1",
        "Cache-Control": "no-store",
      },
    });
  }

  // SSE Stream Mode
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // 1. Initial handshake
      const handshake = `event: handshake\ndata: ${JSON.stringify({
        status: "connected",
        facilitator: "x402-bazaar",
        builderCode: "bc_pa0gqlv1",
        connectedAt: new Date().toISOString(),
        liveSubscribers: 142,
      })}\n\n`;
      controller.enqueue(encoder.encode(handshake));

      // 2. Immediate event burst of initial events
      SAMPLE_STREAM_EVENTS.forEach((evt) => {
        const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      });

      // 3. Heartbeat / ping interval
      const interval = setInterval(() => {
        try {
          const pingEvent = {
            id: `evt-hb-${Date.now()}`,
            type: "heartbeat",
            timestamp: new Date().toISOString(),
            source: "TelemetryDaemon",
            payload: {
              baseGasGwei: 0.0015 + Math.random() * 0.0005,
              settledVolume24hUsdc: 184920 + Math.floor(Math.random() * 50),
              activeAgents: 68 + Math.floor(Math.random() * 10),
            },
          };
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify(pingEvent)}\n\n`));
        } catch {
          clearInterval(interval);
        }
      }, 5000);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "x-builder-code": "bc_pa0gqlv1",
    },
  });
}
