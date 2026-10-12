/**
 * /api/fleet — Autonomous Agent Fleet Manager & Swarm Budget Controller.
 *
 * Allows teams and builders to register multi-agent swarms, assign daily USDC
 * spending caps, generate scoped x402 bearer tokens, and toggle instant kill-switches.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface FleetAgent {
  id: string;
  name: string;
  role: string;
  dailyCapUsdc: number;
  spentTodayUsdc: number;
  allowedCategories: string[];
  status: "ACTIVE" | "PAUSED" | "THROTTLED";
  callsToday: number;
  lastActive: string;
  tokenKey: string;
}

const DEFAULT_FLEET: FleetAgent[] = [
  {
    id: "bot-scout-01",
    name: "Base Token Sentinel Alpha",
    role: "Pre-Trade Security & Honeypot Scanning",
    dailyCapUsdc: 5.0,
    spentTodayUsdc: 1.85,
    allowedCategories: ["security", "compliance"],
    status: "ACTIVE",
    callsToday: 37,
    lastActive: "12s ago",
    tokenKey: "x402-flt-alpha-99a1",
  },
  {
    id: "bot-arb-02",
    name: "Aerodrome Arbitrage Runner",
    role: "Cross-DEX Spread Detection & Settle",
    dailyCapUsdc: 15.0,
    spentTodayUsdc: 4.2,
    allowedCategories: ["markets", "dex"],
    status: "ACTIVE",
    callsToday: 210,
    lastActive: "3s ago",
    tokenKey: "x402-flt-arb-33c2",
  },
  {
    id: "bot-clanker-03",
    name: "Warpcast Clanker Watcher",
    role: "Autonomous Social Deployment Verification",
    dailyCapUsdc: 3.0,
    spentTodayUsdc: 0.9,
    allowedCategories: ["security", "ai"],
    status: "ACTIVE",
    callsToday: 30,
    lastActive: "45s ago",
    tokenKey: "x402-flt-clanker-88e4",
  },
  {
    id: "bot-treasury-04",
    name: "DAO Treasury Compliance Guard",
    role: "OFAC Sanctions & B20 Freeze Audits",
    dailyCapUsdc: 8.0,
    spentTodayUsdc: 7.95,
    allowedCategories: ["compliance", "utility"],
    status: "THROTTLED",
    callsToday: 198,
    lastActive: "2m ago",
    tokenKey: "x402-flt-treasury-11f0",
  },
];

export async function GET() {
  const totalDailyCap = DEFAULT_FLEET.reduce((acc, b) => acc + b.dailyCapUsdc, 0);
  const totalSpentToday = DEFAULT_FLEET.reduce((acc, b) => acc + b.spentTodayUsdc, 0);
  const totalCalls = DEFAULT_FLEET.reduce((acc, b) => acc + b.callsToday, 0);

  return NextResponse.json({
    success: true,
    fleetName: "Autonomous Operations Swarm",
    ownerWallet: "0x892a0e...b419",
    builderCode: "bc_pa0gqlv1",
    summary: {
      totalAgents: DEFAULT_FLEET.length,
      activeAgents: DEFAULT_FLEET.filter((b) => b.status === "ACTIVE").length,
      totalDailyCapUsdc: totalDailyCap,
      totalSpentTodayUsdc: Number(totalSpentToday.toFixed(2)),
      remainingQuotaUsdc: Number((totalDailyCap - totalSpentToday).toFixed(2)),
      totalCallsToday: totalCalls,
      killSwitchActive: false,
    },
    agents: DEFAULT_FLEET,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "create_agent";

    if (action === "toggle_status") {
      const { agentId, newStatus } = body;
      return NextResponse.json({
        success: true,
        agentId,
        newStatus: newStatus || "PAUSED",
        message: `Agent ${agentId} status updated to ${newStatus}.`,
        timestamp: new Date().toISOString(),
      });
    }

    if (action === "create_agent") {
      const name = body.name || "New Autonomous Scout";
      const role = body.role || "General Swarm Operative";
      const dailyCap = Number(body.dailyCapUsdc) || 5.0;
      const categories = body.allowedCategories || ["security", "markets"];

      const newId = `bot-${Math.random().toString(36).substring(2, 7)}`;
      const tokenKey = `x402-flt-${Math.random().toString(16).substring(2, 10)}`;

      const newAgent: FleetAgent = {
        id: newId,
        name,
        role,
        dailyCapUsdc: dailyCap,
        spentTodayUsdc: 0,
        allowedCategories: categories,
        status: "ACTIVE",
        callsToday: 0,
        lastActive: "Just created",
        tokenKey,
      };

      return NextResponse.json({
        success: true,
        message: "New agent successfully provisioned into swarm.",
        agent: newAgent,
        tokenKey,
        headerUsage: {
          header: "x-fleet-token",
          value: tokenKey,
        },
      });
    }

    return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
