import { NextResponse } from "next/server";
import { keccak256, stringToHex } from "viem";

export const dynamic = "force-dynamic";

const BUILDER_CODE = "bc_pa0gqlv1";

export interface AerodromeCLPool {
  id: string;
  name: string;
  pair: string;
  token0: string;
  token1: string;
  feeTierBps: number;
  currentPrice: number;
  currentTick: number;
  tvlUsdc: number;
  feeAprPct: number;
  volatility24hPct: number;
  status: "OPTIMAL" | "DRIFTING" | "OUT_OF_RANGE";
}

export const AERODROME_CL_POOLS: AerodromeCLPool[] = [
  {
    id: "pool-weth-usdc",
    name: "Aerodrome CL: WETH / USDC",
    pair: "WETH-USDC",
    token0: "0x4200000000000000000000000000000000000006",
    token1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    feeTierBps: 5,
    currentPrice: 2642.50,
    currentTick: -78810,
    tvlUsdc: 42850000,
    feeAprPct: 38.4,
    volatility24hPct: 2.1,
    status: "OPTIMAL",
  },
  {
    id: "pool-degen-weth",
    name: "Aerodrome CL: DEGEN / WETH",
    pair: "DEGEN-WETH",
    token0: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    token1: "0x4200000000000000000000000000000000000006",
    feeTierBps: 30,
    currentPrice: 0.0146,
    currentTick: -112450,
    tvlUsdc: 9450000,
    feeAprPct: 124.8,
    volatility24hPct: 9.4,
    status: "DRIFTING",
  },
  {
    id: "pool-aero-usdc",
    name: "Aerodrome CL: AERO / USDC",
    pair: "AERO-USDC",
    token0: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    token1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    feeTierBps: 25,
    currentPrice: 1.18,
    currentTick: -4210,
    tvlUsdc: 18200000,
    feeAprPct: 82.5,
    volatility24hPct: 4.8,
    status: "OPTIMAL",
  },
  {
    id: "pool-virtual-weth",
    name: "Aerodrome CL: VIRTUAL / WETH",
    pair: "VIRTUAL-WETH",
    token0: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    token1: "0x4200000000000000000000000000000000000006",
    feeTierBps: 30,
    currentPrice: 1.42,
    currentTick: -5890,
    tvlUsdc: 14100000,
    feeAprPct: 145.2,
    volatility24hPct: 12.8,
    status: "OUT_OF_RANGE",
  },
];

export async function GET() {
  return NextResponse.json({
    status: "ok",
    network: "Base Mainnet (8453)",
    builderCode: BUILDER_CODE,
    dex: "Aerodrome Finance (Concentrated Liquidity)",
    totalTvlUsdc: AERODROME_CL_POOLS.reduce((acc, p) => acc + p.tvlUsdc, 0),
    pools: AERODROME_CL_POOLS,
  }, {
    headers: {
      "x-builder-code": BUILDER_CODE,
      "Cache-Control": "public, max-age=30",
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const poolId = body.poolId || "pool-weth-usdc";
    const capitalUsdc = Number(body.capitalUsdc || 500);
    const rangeTolerancePct = Number(body.rangeTolerancePct || 5); // default +/- 5%

    const pool = AERODROME_CL_POOLS.find((p) => p.id === poolId) || AERODROME_CL_POOLS[0];

    // Compute optimal tick boundaries based on current price and volatility
    const lowerPrice = pool.currentPrice * (1 - rangeTolerancePct / 100);
    const upperPrice = pool.currentPrice * (1 + rangeTolerancePct / 100);
    
    // Ticks spaced according to pool fee tier
    const tickSpacing = pool.feeTierBps === 5 ? 10 : 60;
    const tickLower = Math.floor(pool.currentTick - (rangeTolerancePct * 100) / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil(pool.currentTick + (rangeTolerancePct * 100) / tickSpacing) * tickSpacing;

    // Projected APY and rebalance cost
    const projectedApy = Number((pool.feeAprPct * (10 / rangeTolerancePct)).toFixed(1));
    const rebalanceCostUsdc = 0.05; // 0.05 USDC x402 payment
    const simulatedTxHash = keccak256(stringToHex(`rebal-${pool.id}-${Date.now()}`));

    return NextResponse.json({
      success: true,
      poolId: pool.id,
      pair: pool.pair,
      dex: "Aerodrome CL (Base)",
      builderCode: BUILDER_CODE,
      currentPrice: pool.currentPrice,
      currentTick: pool.currentTick,
      rebalanceRecommendation: {
        action: pool.status === "OUT_OF_RANGE" ? "URGENT_REBALANCE" : pool.status === "DRIFTING" ? "RECENTER_BAND" : "HOLD_IN_RANGE",
        targetRangePct: `±${rangeTolerancePct}%`,
        lowerPrice: Number(lowerPrice.toFixed(4)),
        upperPrice: Number(upperPrice.toFixed(4)),
        optimalTickLower: tickLower,
        optimalTickUpper: tickUpper,
        projectedConcentratedApy: projectedApy,
        capitalAllocatedUsdc: capitalUsdc,
        rebalanceExecutionFeeUsdc: rebalanceCostUsdc,
      },
      executionPlan: {
        settlementProtocol: "x402 (EIP-3009)",
        gasSponsorship: "100% (0 Gwei on Base)",
        simulatedTxHash,
        explorerUrl: `https://basescan.org/tx/${simulatedTxHash}`,
        status: "READY_TO_SIGN",
      },
    }, {
      headers: {
        "x-builder-code": BUILDER_CODE,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Rebalance planning failed";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
