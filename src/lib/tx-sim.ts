/**
 * Transaction Simulation — "what will this transaction actually do before I sign it".
 *
 * Simulates an UNSIGNED transaction against current Base state via Alchemy's
 * `alchemy_simulateAssetChanges`, and decodes the calldata for approval risk.
 * Returns, from the sender's perspective: what tokens leave / arrive, any
 * approvals granted (flagging unlimited / setApprovalForAll — the classic drain
 * vector), whether it would revert, and gas. This is the highest-stakes
 * pre-execution question an agent faces; nobody else on x402 answers it.
 *
 * Metered upstream (Alchemy) → registered paid-only (noFreeTier).
 */

import "server-only";
import { getAddress, parseEther } from "viem";

const rpcUrl = (k: string) => `https://base-mainnet.g.alchemy.com/v2/${k}`;
const MAX_UINT = (2n ** 256n - 1n).toString();

function key(): string {
  const k = process.env.ALCHEMY_API_KEY?.trim();
  if (!k) throw new Error("Simulation not configured: set ALCHEMY_API_KEY");
  return k;
}

function reqAddr(raw: string, label: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Provide a valid 0x… ${label} address`);
  return getAddress(v);
}

// value may be decimal ETH ("0.1") or a 0x-hex wei value; normalise to hex wei.
function toHexWei(raw?: string): string {
  const v = (raw || "").trim();
  if (!v || v === "0") return "0x0";
  if (v.startsWith("0x")) return v;
  try {
    return "0x" + parseEther(v).toString(16);
  } catch {
    throw new Error("value must be ETH (e.g. 0.1) or a 0x hex wei amount");
  }
}

// Risky method selectors an agent should be warned about.
const SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve",
  "0xa22cb465": "setApprovalForAll",
  "0x39509351": "increaseAllowance",
  "0xd505accf": "permit",
  "0x23b872dd": "transferFrom",
  "0xa9059cbb": "transfer",
};

interface AlchemyChange {
  assetType?: string; // NATIVE | ERC20 | ERC721 | ERC1155 | SPECIAL_NFT
  changeType?: string; // TRANSFER | APPROVE
  from?: string;
  to?: string;
  rawAmount?: string;
  amount?: string;
  symbol?: string;
  decimals?: number;
  contractAddress?: string;
  tokenId?: string;
  name?: string;
}
interface SimResult {
  changes?: AlchemyChange[];
  gasUsed?: string;
  error?: { message?: string } | string | null;
}

export async function simulateTx(params: Record<string, string>) {
  const from = reqAddr(params.from || "", "from (sender)");
  const to = reqAddr(params.to || "", "to (recipient/contract)");
  const data = (params.data || params.calldata || "0x").trim();
  if (data !== "0x" && !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new Error("data/calldata must be 0x-prefixed hex");
  }
  const value = toHexWei(params.value);
  const k = key();

  const tx = { from, to, value, data };
  const res = await fetch(rpcUrl(k), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_simulateAssetChanges", params: [tx] }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Simulation upstream responded ${res.status}`);
  const j = (await res.json()) as { result?: SimResult; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "Simulation RPC error");
  const sim = j.result || {};

  const errMsg =
    typeof sim.error === "string" ? sim.error : sim.error?.message ? sim.error.message : null;
  const willRevert = Boolean(errMsg);

  const lc = (s?: string) => (s || "").toLowerCase();
  const fromLc = from.toLowerCase();

  // Normalise each change from the SENDER's perspective.
  const changes = (sim.changes || []).map((c) => {
    const isApprove = c.changeType === "APPROVE";
    const unlimited = isApprove && c.rawAmount === MAX_UINT;
    let direction: "out" | "in" | "approve" | "other" = "other";
    if (isApprove) direction = "approve";
    else if (lc(c.from) === fromLc) direction = "out";
    else if (lc(c.to) === fromLc) direction = "in";
    return {
      assetType: c.assetType ?? null,
      direction,
      symbol: c.symbol ?? c.name ?? null,
      amount: c.amount ?? null,
      contractAddress: c.contractAddress ?? null,
      tokenId: c.tokenId ?? null,
      to: c.to ?? null,
      unlimited: unlimited || undefined,
    };
  });

  // Calldata action + risk flags.
  const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
  const method = selector ? (SELECTORS[selector] ?? null) : null;
  const approvals = changes.filter((c) => c.direction === "approve");
  const flags: string[] = [];
  if (willRevert) flags.push("would_revert");
  if (approvals.some((a) => a.unlimited)) flags.push("unlimited_approval");
  if (method === "setApprovalForAll") flags.push("set_approval_for_all");
  if (approvals.length > 0) flags.push("grants_approval");
  if (changes.some((c) => c.direction === "out" && c.assetType === "NATIVE")) flags.push("sends_native");
  if (changes.some((c) => c.direction === "out")) flags.push("moves_assets_out");

  // Simple risk level for agents.
  const level =
    flags.includes("unlimited_approval") || flags.includes("set_approval_for_all")
      ? "high"
      : willRevert
        ? "review"
        : flags.includes("moves_assets_out") || flags.includes("grants_approval")
          ? "medium"
          : "low";

  const outgoing = changes.filter((c) => c.direction === "out");
  const incoming = changes.filter((c) => c.direction === "in");

  return {
    from,
    to,
    method, // decoded method name if recognised (approve, transfer, …)
    willRevert,
    revertReason: errMsg,
    gasUsed: sim.gasUsed ?? null,
    riskLevel: level, // low | medium | review | high
    flags, // machine-readable risk flags
    summary: {
      assetsOut: outgoing.length,
      assetsIn: incoming.length,
      approvalsGranted: approvals.length,
    },
    outgoing, // what leaves the sender
    incoming, // what arrives to the sender
    approvals, // approvals this tx would grant (watch unlimited/setApprovalForAll)
    note: "Pre-execution simulation against current Base state. Not financial advice; simulate again just before signing as state can change.",
    simulatedAt: new Date().toISOString(),
  };
}
