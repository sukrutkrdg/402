import { NextResponse } from "next/server";
import { keccak256, toHex, stringToHex } from "viem";

export const dynamic = "force-dynamic";

const BASE_CHAIN_ID = 8453;
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const X402_SETTLER_CONTRACT = "0x4020000000000000000000000000000000000402";
const BUILDER_CODE = "bc_pa0gqlv1";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const serviceId = body.serviceId || "clanker-token-audit";
    const amountUsdc = Number(body.amountUsdc || 0.05);
    const buyerAddress = body.buyerAddress || "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";
    const agentRole = body.agentRole || "Autonomous Arbitrage & Sentinel Bot";
    const startingBalance = Number(body.startingBalance || 10.0);

    const nowSec = Math.floor(Date.now() / 1000);
    const validAfter = 0;
    const validBefore = nowSec + 3600; // 1 hour validity

    // Generate deterministic yet pseudo-random nonce & mock hash
    const rawNonce = `nonce-${nowSec}-${Math.random().toString(16).slice(2, 10)}`;
    const nonce = keccak256(stringToHex(rawNonce));

    // Value in 6 decimals (USDC standard)
    const rawValue = BigInt(Math.round(amountUsdc * 1e6)).toString();

    // EIP-712 Typed Data Specification for EIP-3009 TransferWithAuthorization
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: BASE_USDC_CONTRACT,
    };

    const message = {
      from: buyerAddress,
      to: X402_SETTLER_CONTRACT,
      value: rawValue,
      validAfter,
      validBefore,
      nonce,
    };

    // Calculate simulated typed data digest
    const digestSeed = `${JSON.stringify(domain)}:${JSON.stringify(message)}`;
    const typedDataHash = keccak256(stringToHex(digestSeed));

    // Mock ECDSA signature (v, r, s)
    const r = keccak256(stringToHex(`r-${typedDataHash}`));
    const s = keccak256(stringToHex(`s-${typedDataHash}`));
    const v = 27;

    // Financial split (90% to Publisher, 10% Platform fee)
    const publisherPayoutUsdc = Number((amountUsdc * 0.90).toFixed(4));
    const platformFeeUsdc = Number((amountUsdc * 0.10).toFixed(4));
    const remainingMockBalanceUsdc = Number(Math.max(0, startingBalance - amountUsdc).toFixed(4));

    // Simulated Block & Transaction on Base
    const blockNumber = 21458900 + Math.floor(Math.random() * 5000);
    const txHash = keccak256(stringToHex(`tx-${nowSec}-${rawNonce}`));
    const latencyMs = Math.floor(12 + Math.random() * 15); // sub-30ms execution

    return NextResponse.json({
      success: true,
      simulationId: `sim-${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      serviceId,
      eip712: {
        domain,
        primaryType: "TransferWithAuthorization",
        message,
        typedDataHash,
        signature: {
          v,
          r,
          s,
          compactHex: `${r}${s.slice(2)}${toHex(v).slice(2)}`,
        },
      },
      settlement: {
        network: "Base Mainnet",
        chainId: BASE_CHAIN_ID,
        usdcTokenAddress: BASE_USDC_CONTRACT,
        settlerContract: X402_SETTLER_CONTRACT,
        txHash,
        blockNumber,
        gasUsedGwei: 0.0018,
        gasSponsoredByFacilitator: true,
        builderCode: BUILDER_CODE,
        totalAmountUsdc: amountUsdc,
        publisherPayoutUsdc,
        platformFeeUsdc,
        latencyMs,
        explorerUrl: `https://basescan.org/tx/${txHash}`,
      },
      buyerAgent: {
        address: buyerAddress,
        role: agentRole,
        spentUsdc: amountUsdc,
        remainingMockBalanceUsdc,
      },
    }, {
      headers: {
        "x-builder-code": BUILDER_CODE,
        "x-eip3009-simulated": "true",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Simulation failed";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
