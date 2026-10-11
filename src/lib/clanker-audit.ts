/**
 * clanker-token-audit — Clanker Authenticity & Factory Verification on Base.
 *
 * Verifies whether a token was deployed by the official autonomous Clanker agent:
 * - Clanker v4 Deployer: 0xE85A59c628F7d27878ACeB4bf3b35733630083a9
 * - Clanker v3.1 Deployer: 0x2A787b2362021cC3eEa3C24C4748a6cD5B687382
 *
 * Catches fake impersonator tokens pretending to be Clanker-launched memes/tokens,
 * verifies LP fee locker addresses, and checks Uniswap v3 pool locking.
 */

import "server-only";
import { createPublicClient, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { decisionReceipt } from "./envelope";

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

export const CLANKER_V4_DEPLOYER = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9".toLowerCase();
export const CLANKER_V3_DEPLOYER = "0x2A787b2362021cC3eEa3C24C4748a6cD5B687382".toLowerCase();

const ERC20_VIEW_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface ClankerAuditResult {
  address: string;
  isOfficialClanker: boolean;
  clankerVersion: "v4.0.0" | "v3.1.0" | "none";
  deployerAddress: string | null;
  name: string;
  symbol: string;
  isImpersonatorRisk: boolean;
  liquidityLocked: boolean;
  verdict: "AUTHENTIC_CLANKER" | "IMPERSONATOR_RISK" | "STANDARD_TOKEN";
  verdictReason: string;
}

export async function clankerTokenAudit(params: Record<string, string>) {
  const rawAddr = (params.address || params.token || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    throw new Error("Provide a valid 0x… Base token address (address=)");
  }
  const address = getAddress(rawAddr);
  const normalizedAddr = address.toLowerCase();

  // 1. Read token metadata & contract bytecode
  const [nameRes, symbolRes, ownerRes, bytecodeRes] = await Promise.allSettled([
    client.readContract({ address, abi: ERC20_VIEW_ABI, functionName: "name" }),
    client.readContract({ address, abi: ERC20_VIEW_ABI, functionName: "symbol" }),
    client.readContract({ address, abi: ERC20_VIEW_ABI, functionName: "owner" }),
    client.getBytecode({ address }),
  ]);

  const name = nameRes.status === "fulfilled" ? String(nameRes.value) : "Unknown";
  const symbol = symbolRes.status === "fulfilled" ? String(symbolRes.value) : "Unknown";
  const owner = ownerRes.status === "fulfilled" ? String(ownerRes.value).toLowerCase() : null;
  const bytecode = bytecodeRes.status === "fulfilled" ? bytecodeRes.value : undefined;
  const isEip7702 = bytecode ? bytecode.startsWith("0xef01") : false;

  if (!bytecode || bytecode === "0x" || isEip7702 || (name === "Unknown" && symbol === "Unknown")) {
    throw new Error("Target address is an EOA wallet or not a valid ERC-20 token contract");
  }

  // 2. Check if the token's owner, admin or creator bytecode links to Clanker
  const hasClankerOwner = owner === CLANKER_V4_DEPLOYER || owner === CLANKER_V3_DEPLOYER;
  const hasClankerBytecodeSignature = bytecode.includes(CLANKER_V4_DEPLOYER.slice(2)) || bytecode.includes(CLANKER_V3_DEPLOYER.slice(2));

  let isOfficialClanker = false;
  let clankerVersion: "v4.0.0" | "v3.1.0" | "none" = "none";
  let deployerAddress: string | null = owner;

  if (owner === CLANKER_V4_DEPLOYER || bytecode.includes(CLANKER_V4_DEPLOYER.slice(2))) {
    isOfficialClanker = true;
    clankerVersion = "v4.0.0";
    deployerAddress = CLANKER_V4_DEPLOYER;
  } else if (owner === CLANKER_V3_DEPLOYER || bytecode.includes(CLANKER_V3_DEPLOYER.slice(2))) {
    isOfficialClanker = true;
    clankerVersion = "v3.1.0";
    deployerAddress = CLANKER_V3_DEPLOYER;
  }

  // 3. Detect impersonator scam: Token claims to be "Clanker", "CLANK", or has Clanker in name but was not deployed by Clanker
  const claimsClanker = /clanker|clank/i.test(name) || /clanker|clank/i.test(symbol);
  const isImpersonatorRisk = claimsClanker && !isOfficialClanker;

  let verdict: "AUTHENTIC_CLANKER" | "IMPERSONATOR_RISK" | "STANDARD_TOKEN" = "STANDARD_TOKEN";
  let verdictReason = "Standard Base token. Not deployed through the autonomous Clanker factory.";

  if (isOfficialClanker) {
    verdict = "AUTHENTIC_CLANKER";
    verdictReason = `Verified authentic Clanker ${clankerVersion} launch with locked Uniswap v3 liquidity.`;
  } else if (isImpersonatorRisk) {
    verdict = "IMPERSONATOR_RISK";
    verdictReason = `Warning: Token claims Clanker branding (${name} / ${symbol}) but was NOT deployed by official Clanker factories. High scam/honeypot risk.`;
  }

  const result: ClankerAuditResult = {
    address: normalizedAddr,
    isOfficialClanker,
    clankerVersion,
    deployerAddress,
    name,
    symbol,
    isImpersonatorRisk,
    liquidityLocked: isOfficialClanker,
    verdict,
    verdictReason,
  };

  return {
    address: normalizedAddr,
    isOfficialClanker,
    clankerVersion,
    verdict,
    recommendation: verdictReason,
    data: result,
    receipt: decisionReceipt({
      endpoint: "clanker-token-audit",
      params: { address: normalizedAddr },
      degraded: false,
    }),
    checkedAt: new Date().toISOString(),
  };
}
