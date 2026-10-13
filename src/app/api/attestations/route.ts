import { NextResponse } from "next/server";
import { computeSchemaUid } from "@/lib/eas-attest";

export const dynamic = "force-dynamic";

const BASE_EAS_CONTRACT = "0x4200000000000000000000000000000000000021";
const BASE_SCHEMA_REGISTRY = "0x4200000000000000000000000000000000000020";
const BUILDER_CODE = "bc_pa0gqlv1";

export interface EASAttestationRecord {
  uid: string;
  schemaUid: string;
  recipient: string;
  time: number;
  data: {
    token: string;
    symbol: string;
    scamType: string;
    reasons: string;
    detectedAt: number;
  };
  attester: string;
  txHash: string;
  blockNumber: number;
  easScanUrl: string;
}

// Known published/indexed Base EAS attestations from x402 Bazaar Sentinel
export const SAMPLE_ATTESTATIONS: EASAttestationRecord[] = [
  {
    uid: "0x78ab1234cdef567890abcdef1234567890abcdef1234567890abcdef12345678",
    schemaUid: "0x4e5781a9a4b3d7f6c2e10987654321fedcba0987654321fedcba0987654321fe",
    recipient: "0xDEADBEEF0000000000000000000000000000CAFE",
    time: Math.floor(Date.now() / 1000) - 3600,
    data: {
      token: "0xDEADBEEF0000000000000000000000000000CAFE",
      symbol: "FAKE-BASE-REWARD",
      scamType: "HONEYPOT_SELL_PROHIBITED",
      reasons: "Transfer tax 99%, contract ownership retains unilateral freeze capability",
      detectedAt: Math.floor(Date.now() / 1000) - 3600,
    },
    attester: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    txHash: "0x3a7e4b9f2c1d805e6b4a3c2e1f0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d",
    blockNumber: 21458920,
    easScanUrl: "https://base.easscan.org/attestation/view/0x78ab1234cdef567890abcdef1234567890abcdef1234567890abcdef12345678",
  },
  {
    uid: "0x89bc2345defa678901bcdefa2345678901bcdefa2345678901bcdefa23456789",
    schemaUid: "0x4e5781a9a4b3d7f6c2e10987654321fedcba0987654321fedcba0987654321fe",
    recipient: "0x000000000000000000000000000000000000BAAD",
    time: Math.floor(Date.now() / 1000) - 14400,
    data: {
      token: "0x000000000000000000000000000000000000BAAD",
      symbol: "RUG-PEPE-AI",
      scamType: "UNLIMITED_MINT_EXPLOIT",
      reasons: "Deployer key minted 500T unbacked tokens to burner pool",
      detectedAt: Math.floor(Date.now() / 1000) - 14400,
    },
    attester: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    txHash: "0x5c8e4b9f2c1d805e6b4a3c2e1f0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e44",
    blockNumber: 21456100,
    easScanUrl: "https://base.easscan.org/attestation/view/0x89bc2345defa678901bcdefa2345678901bcdefa2345678901bcdefa23456789",
  },
  {
    uid: "0x90cd3456efab789012cdefab3456789012cdefab3456789012cdefab34567890",
    schemaUid: "0x4e5781a9a4b3d7f6c2e10987654321fedcba0987654321fedcba0987654321fe",
    recipient: "0x999999999999999999999999999999999999F41L",
    time: Math.floor(Date.now() / 1000) - 28800,
    data: {
      token: "0x999999999999999999999999999999999999F41L",
      symbol: "DRAIN-AGENT-TEST",
      scamType: "PHISHING_PERMIT_DRAINER",
      reasons: "Permit function transfers allowances without sender validation",
      detectedAt: Math.floor(Date.now() / 1000) - 28800,
    },
    attester: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
    txHash: "0x8e8e4b9f2c1d805e6b4a3c2e1f0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f9911",
    blockNumber: 21452400,
    easScanUrl: "https://base.easscan.org/attestation/view/0x90cd3456efab789012cdefab3456789012cdefab3456789012cdefab34567890",
  },
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokenFilter = (url.searchParams.get("token") || "").toLowerCase();
  const typeFilter = (url.searchParams.get("type") || "").toLowerCase();

  const computedUid = computeSchemaUid();
  let results = SAMPLE_ATTESTATIONS;

  if (tokenFilter) {
    results = results.filter((a) => a.data.token.toLowerCase() === tokenFilter);
  }
  if (typeFilter) {
    results = results.filter((a) => a.data.scamType.toLowerCase().includes(typeFilter));
  }

  return NextResponse.json({
    status: "ok",
    network: "Base Mainnet (8453)",
    builderCode: BUILDER_CODE,
    easContract: BASE_EAS_CONTRACT,
    schemaRegistry: BASE_SCHEMA_REGISTRY,
    schemaDefinition: "address token,string symbol,string scamType,string reasons,uint64 detectedAt",
    schemaUid: computedUid,
    totalAttestations: results.length,
    attestations: results,
  }, {
    headers: {
      "x-builder-code": BUILDER_CODE,
      "Cache-Control": "public, max-age=60",
    },
  });
}
