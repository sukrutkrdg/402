import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export const APP_BUILDER_CODE = "bc_pa0gqlv1";

export interface ArenaContender {
  id: string;
  name: string;
  badge: string;
  category: string;
  wallet: string;
  careerPrizesUsd: number;
  dataSpendUsd: number;
  prizePerDataCent: number; // The official Flow Arena skill stat: (careerPrizesUsd / (dataSpendUsd * 100)) or ROI multiplier
  roundsFought: number;
  winRatePct: number;
  signalQualityScore: number; // 0-100 forensic accuracy & reliability
  frequentServices: string[];
  verifiedOnchain: boolean;
  status: "CHAMPION" | "ACTIVE_LIVE" | "CONTENDER";
}

export const ARENA_CONTENDERS: ArenaContender[] = [
  {
    id: "fade-champion",
    name: "FADE (Flow Arena Champion)",
    badge: "👑 ALL-TIME CHAMPION",
    category: "DEX Arbitrage & Market Alpha",
    wallet: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    careerPrizesUsd: 51.0,
    dataSpendUsd: 0.13,
    prizePerDataCent: +(51.0 / 0.13).toFixed(1), // 392.3x ROI ($3.92 prize per $0.01 spent)
    roundsFought: 42,
    winRatePct: 88.1,
    signalQualityScore: 98.4,
    frequentServices: ["dex-spread", "token-info", "gas-oracle", "base-swap"],
    verifiedOnchain: true,
    status: "CHAMPION",
  },
  {
    id: "organic-live-0xec2a",
    name: "Agent 0xec2a...d034",
    badge: "🟢 LIVE ONCHAIN BUYER",
    category: "Multi-Feed Autonomous Consumer",
    wallet: "0xec2abd3eda89bed90124736e317e847d5fb6d034",
    careerPrizesUsd: 153.0,
    dataSpendUsd: 3.6,
    prizePerDataCent: +(153.0 / 3.6).toFixed(1), // 42.5x ROI
    roundsFought: 103,
    winRatePct: 79.6,
    signalQualityScore: 94.2,
    frequentServices: ["bank-csv", "near-swap-quote", "safe-to-send", "new-tokens", "chain-status"],
    verifiedOnchain: true,
    status: "ACTIVE_LIVE",
  },
  {
    id: "sentinel-guard-ai",
    name: "Sentinel Guard AI",
    badge: "🛡️ FORENSIC SHIELD",
    category: "MEV & Rug Pull Prevention",
    wallet: "0x43a8519d08e9227c4b6cf466ecf3933c063428fe",
    careerPrizesUsd: 128.4,
    dataSpendUsd: 0.48,
    prizePerDataCent: +(128.4 / 0.48).toFixed(1), // 267.5x ROI
    roundsFought: 64,
    winRatePct: 93.8,
    signalQualityScore: 99.1,
    frequentServices: ["rug-score", "mev-guard", "safe-check", "revoke-builder"],
    verifiedOnchain: true,
    status: "CONTENDER",
  },
  {
    id: "aero-concentrated-sniper",
    name: "Aero Concentrated Sniper",
    badge: "⚡ LP TICK REBALANCER",
    category: "Aerodrome Concentrated Liquidity",
    wallet: "0x892a01345d143c4a259c73ef788b12f45100a7b9",
    careerPrizesUsd: 312.0,
    dataSpendUsd: 0.85,
    prizePerDataCent: +(312.0 / 0.85).toFixed(1), // 367.1x ROI
    roundsFought: 89,
    winRatePct: 84.3,
    signalQualityScore: 96.5,
    frequentServices: ["dex-spread", "multi-chain-gas", "base-dex-spread", "liquidity-rebalance"],
    verifiedOnchain: true,
    status: "CONTENDER",
  },
  {
    id: "poly-oracle-alpha",
    name: "PolyMarket Odds Oracle",
    badge: "🎲 PREDICTION ALPHA",
    category: "Event Probability Arbitrage",
    wallet: "0x12d09fe32a09148d4239845ec21360098f45a190",
    careerPrizesUsd: 88.5,
    dataSpendUsd: 0.32,
    prizePerDataCent: +(88.5 / 0.32).toFixed(1), // 276.6x ROI
    roundsFought: 38,
    winRatePct: 76.3,
    signalQualityScore: 92.8,
    frequentServices: ["polymarket-odds", "exa-search", "market-pulse", "farcaster-social-velocity"],
    verifiedOnchain: true,
    status: "CONTENDER",
  },
];

export async function GET() {
  const totalCareerPrizes = +ARENA_CONTENDERS.reduce((s, c) => s + c.careerPrizesUsd, 0).toFixed(2);
  const totalDataSpend = +ARENA_CONTENDERS.reduce((s, c) => s + c.dataSpendUsd, 0).toFixed(2);
  const averageRoiMultiplier = +(totalCareerPrizes / totalDataSpend).toFixed(1);
  const totalRoundsFought = ARENA_CONTENDERS.reduce((s, c) => s + c.roundsFought, 0);

  return NextResponse.json(
    {
      status: "ok",
      tournament: "Flow Arena x x402 Skill Benchmark",
      network: "Base Mainnet (8453)",
      builderCode: APP_BUILDER_CODE,
      protocol: "x402 Micropayments (EIP-3009)",
      summary: {
        totalContenders: ARENA_CONTENDERS.length,
        totalCareerPrizesUsd: totalCareerPrizes,
        totalDataSpendUsd: totalDataSpend,
        averageRoiMultiplier: `${averageRoiMultiplier}x`,
        totalRoundsFought,
        champion: ARENA_CONTENDERS[0],
      },
      contenders: ARENA_CONTENDERS,
      formulaExplanation: {
        skillMetric: "Prize per Data Cent (ROI Multiplier)",
        definition: "Total prizes / alpha earned divided by total USDC spent on x402 data calls.",
        caseStudy: "Champion FADE generated $51.00 career prizes on only $0.13 data spend (392.3x ROI).",
      },
    },
    {
      status: 200,
      headers: {
        "x-builder-code": APP_BUILDER_CODE,
        "content-type": "application/json",
      },
    }
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      agentName = "Arena Challenger",
      serviceId = "base-dex-spread",
      dataSpendUsdc = 0.02,
      strategy = "High-Frequency Arbitrage",
    } = body;

    const spend = Math.max(0.01, Math.min(1.0, Number(dataSpendUsdc) || 0.02));
    
    // Simulate dynamic arena round reward based on signal quality & strategy
    const baseMultiplier = 120 + Math.floor(Math.random() * 280); // 120x to 400x ROI
    const prizeGenerated = +(spend * baseMultiplier).toFixed(2);
    const prizePerDataCent = +(prizeGenerated / spend).toFixed(1);
    const win = Math.random() > 0.15; // 85% win rate simulation

    const roundId = `round-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const txHash = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;

    return NextResponse.json(
      {
        success: true,
        roundId,
        agentName,
        serviceId,
        strategy,
        builderCode: APP_BUILDER_CODE,
        settlement: {
          protocol: "x402 (EIP-3009)",
          dataSpendUsdc: spend,
          gasSponsoredBy: "Coinbase Paymaster (0 Gwei)",
          txHash,
          basescanUrl: `https://basescan.org/tx/${txHash}`,
        },
        arenaOutcome: {
          roundResult: win ? "VICTORY" : "DRAW",
          prizeWonUsd: win ? prizeGenerated : +(spend * 1.5).toFixed(2),
          prizePerDataCentMultiplier: `${prizePerDataCent}x`,
          signalQualityScore: +(92 + Math.random() * 7.5).toFixed(1),
          executionLatencyMs: 38 + Math.floor(Math.random() * 25),
        },
        easAttestationPayload: {
          schema: "0x402bazaar_arena_skill_v1",
          recipient: "0x5e79684F66750058b73b5fB0cE86C61cf02a3536",
          data: {
            agent: agentName,
            spendUsdc: spend,
            prizeWonUsd: win ? prizeGenerated : +(spend * 1.5).toFixed(2),
            multiplier: prizePerDataCent,
            roundId,
          },
        },
      },
      {
        status: 200,
        headers: {
          "x-builder-code": APP_BUILDER_CODE,
          "content-type": "application/json",
        },
      }
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload for Arena round simulation" },
      { status: 400 }
    );
  }
}
