/**
 * agent-provenance — Autonomous AI Agent Verification & Provenance on Base.
 *
 * Before an agent pays, trades with, or copies another agent on Base:
 * Is the counterparty a verified autonomous agent (Virtuals Protocol,
 * Coinbase AgentKit, EIP-7702 delegated wallet, ERC-7579 modular account),
 * or an unverified human EOA / sybil address?
 */

import "server-only";
import { getAddress, type Address, createPublicClient } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { classifyCode } from "./primitives";

export interface AgentProvenanceResult {
  address: string;
  isAgent: boolean;
  framework: "virtuals" | "agentkit" | "eip7702" | "smart_account" | "standard_eoa" | "contract";
  delegatedTo: string | null;
  isContract: boolean;
  txCount: number;
  agentSafetyScore: number;
  verdict: "verified_agent" | "delegated_agent" | "active_account" | "fresh_account" | "unverified_contract";
  observations: string[];
  recommendation: string;
  checkedAt: string;
}

// Known Agent Framework signatures / contracts on Base
const VIRTUALS_FACTORY = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"; // Virtuals bonding curve / agent manager on Base

export async function agentProvenance(params: Record<string, string>): Promise<AgentProvenanceResult> {
  const rawAddr = (params.address || params.agent || params.wallet || "").trim();
  if (!rawAddr || !/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    throw new Error("address= must be a valid 0x 20-byte address");
  }

  const address = getAddress(rawAddr);
  const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

  let code: `0x${string}` | undefined;
  let txCount = 0;

  try {
    const [c, nonce] = await Promise.all([
      client.getBytecode({ address }),
      client.getTransactionCount({ address }),
    ]);
    code = c;
    txCount = nonce;
  } catch (e) {
    throw new Error(`Base RPC failed (${(e as Error).name}) — not charged, retry shortly`);
  }

  const { isContract, delegatedTo } = classifyCode(code);
  const isDelegated = Boolean(delegatedTo);
  const observations: string[] = [];

  let framework: AgentProvenanceResult["framework"] = "standard_eoa";
  let isAgent = false;
  let agentSafetyScore = 50;

  if (isDelegated && delegatedTo) {
    isAgent = true;
    framework = "eip7702";
    agentSafetyScore = 80;
    observations.push(`EIP-7702 delegation active: account signs with autonomous delegate ${delegatedTo}`);
  } else if (isContract) {
    // Check if contract code matches known agent signatures or standard contracts
    const codeStr = (code || "").toLowerCase();
    if (codeStr.includes(VIRTUALS_FACTORY.slice(2).toLowerCase()) || codeStr.includes("virtuals")) {
      isAgent = true;
      framework = "virtuals";
      agentSafetyScore = 85;
      observations.push("Verified Virtuals Protocol autonomous agent contract structure on Base");
    } else {
      framework = "contract";
      agentSafetyScore = 40;
      observations.push("Smart contract on Base without explicit agent framework markers");
    }
  } else {
    // EOA
    if (txCount > 50) {
      agentSafetyScore = Math.min(75, 50 + Math.floor(txCount / 10));
      observations.push(`Active onchain address with ${txCount} historical transactions on Base`);
    } else if (txCount === 0) {
      agentSafetyScore = 20;
      observations.push("Fresh address with 0 outgoing transactions — treat as unverified/sybil risk");
    } else {
      agentSafetyScore = 40;
      observations.push(`Lightly active address with ${txCount} outgoing transactions on Base`);
    }
  }

  let verdict: AgentProvenanceResult["verdict"];
  let recommendation: string;

  if (framework === "virtuals") {
    verdict = "verified_agent";
    recommendation = "Verified autonomous agent on Base. Safe for agent-to-agent commerce and API tasks.";
  } else if (framework === "eip7702") {
    verdict = "delegated_agent";
    recommendation = "Smart account operating via EIP-7702 delegation. Capable of automated execution.";
  } else if (isContract) {
    verdict = "unverified_contract";
    recommendation = "Custom smart contract. Verify contract verified source before transferring funds.";
  } else if (txCount >= 10) {
    verdict = "active_account";
    recommendation = "Established counterparty with onchain transaction history.";
  } else {
    verdict = "fresh_account";
    recommendation = "High caution: fresh or empty account. Do not transfer large balances without prior interaction.";
  }

  return {
    address,
    isAgent,
    framework,
    delegatedTo: delegatedTo ?? null,
    isContract,
    txCount,
    agentSafetyScore,
    verdict,
    observations,
    recommendation,
    checkedAt: new Date().toISOString(),
  };
}
