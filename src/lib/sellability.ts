/**
 * Sellability Check — "can you actually SELL this token, or is it a honeypot?"
 *
 * The hard question a static price feed never answers. Combines three angles:
 *   1) Security simulation (GoPlus): honeypot, cannot-sell-all, sell/buy tax,
 *      transfer-pausable, blacklist.
 *   2) A live TRANSFER SIMULATION we run ourselves (Alchemy) from a real top
 *      holder — if a transfer reverts or gets taxed, sells are restricted.
 *   3) Exit liquidity — even if sellable, can the pool absorb the size.
 * Returns a hard canSell verdict with reasons. Selling is where rugs hide.
 */

import "server-only";
import { getAddress } from "viem";
import { tokenRisk } from "./onchain";
import { holderDistribution } from "./holders";
import { exitLiquidity } from "./liquidity";

const rpcUrl = (k: string) => `https://base-mainnet.g.alchemy.com/v2/${k}`;
const ZERO_ISH = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

function reqAddr(raw: string): string {
  const v = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Provide a valid 0x… token address");
  return getAddress(v);
}

// transfer(address,uint256) calldata for a tiny amount, to probe transfer mechanics.
function transferCalldata(to: string, amountWei = 1000n): string {
  const toPad = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amtPad = amountWei.toString(16).padStart(64, "0");
  return `0xa9059cbb${toPad}${amtPad}`;
}

// Best-effort live transfer simulation from a real holder. Returns a small verdict.
async function simulateTransfer(
  token: string,
  holder: string,
): Promise<{ ran: boolean; transferReverts?: boolean; taxedOnTransfer?: boolean; note: string }> {
  const k = process.env.ALCHEMY_API_KEY?.trim();
  if (!k) return { ran: false, note: "Alchemy not configured — transfer simulation skipped." };
  try {
    const recipient = "0x000000000000000000000000000000000000dEaD";
    const tx = { from: holder, to: token, value: "0x0", data: transferCalldata(recipient) };
    const res = await fetch(rpcUrl(k), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_simulateAssetChanges", params: [tx] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ran: false, note: `Simulation upstream ${res.status}` };
    const j = (await res.json()) as {
      result?: { changes?: Array<{ to?: string; from?: string; rawAmount?: string }>; error?: { message?: string } | string };
    };
    const sim = j.result || {};
    const err = typeof sim.error === "string" ? sim.error : sim.error?.message;
    if (err) return { ran: true, transferReverts: true, note: `Transfer reverts in simulation: ${err}` };
    // If the recipient received strictly less than sent → transfer is taxed.
    const got = (sim.changes || []).find((c) => (c.to || "").toLowerCase() === recipient.toLowerCase());
    const taxed = got ? BigInt(got.rawAmount || "0") < 1000n : false;
    return {
      ran: true,
      transferReverts: false,
      taxedOnTransfer: taxed,
      note: taxed ? "Transfer succeeds but is taxed (recipient got less)." : "Transfer succeeds cleanly in simulation.",
    };
  } catch (e) {
    return { ran: false, note: `Simulation error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

interface SecurityShape {
  isHoneypot?: boolean;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  transferPausable?: boolean;
}
interface RiskShape {
  // tokenRisk() nests honeypot/tax/pausable under `security`; only `flags` is
  // top-level. Reading these off the top level silently yields null → the
  // high-tax verdict never fires. Read from `security`.
  security?: SecurityShape;
  flags?: string[];
}

export async function sellability(params: Record<string, string>) {
  const token = reqAddr(params.address || "");

  const [riskR, holdersR, exitR] = await Promise.allSettled([
    tokenRisk({ address: token }),
    holderDistribution({ address: token }),
    exitLiquidity({ address: token, size: params.size || "5000" }),
  ]);
  const risk = (riskR.status === "fulfilled" ? riskR.value : null) as RiskShape | null;
  const holders = holdersR.status === "fulfilled" ? (holdersR.value as { topHolders?: Array<{ address?: string | null }> }) : null;
  const exit = exitR.status === "fulfilled" ? (exitR.value as Record<string, unknown>) : null;

  if (!risk && !exit) throw new Error("No data available for this token");

  // Pick a real holder that isn't a burn/zero address for the transfer probe.
  const holderAddr = (holders?.topHolders || [])
    .map((h) => h.address)
    .find((a): a is string => Boolean(a) && !ZERO_ISH.has((a || "").toLowerCase()));

  const sim = holderAddr ? await simulateTransfer(token, holderAddr) : { ran: false, note: "No usable holder for transfer simulation." };

  const flags = risk?.flags || [];
  const sec = risk?.security;
  const honeypot = Boolean(sec?.isHoneypot) || flags.includes("honeypot");
  const cannotSellAll = flags.includes("cannot_sell_all");
  const sellTax = typeof sec?.sellTaxPct === "number" ? sec.sellTaxPct : null;
  const buyTax = typeof sec?.buyTaxPct === "number" ? sec.buyTaxPct : null;
  const transferPausable = Boolean(sec?.transferPausable) || flags.includes("transfer_pausable");
  const canExit = exit ? Boolean((exit as { canExit?: boolean }).canExit) : null;

  const reasons: string[] = [];
  let canSell = true;
  if (honeypot) { canSell = false; reasons.push("Flagged as a honeypot by security analysis."); }
  if (cannotSellAll) { canSell = false; reasons.push("Contract restricts selling the full balance (cannot_sell_all)."); }
  if (sim.ran && sim.transferReverts) { canSell = false; reasons.push("A token transfer reverts in live simulation."); }
  if (sellTax !== null && sellTax >= 50) { canSell = false; reasons.push(`Extreme sell tax (${sellTax}%).`); }
  else if (sellTax !== null && sellTax >= 15) reasons.push(`High sell tax (${sellTax}%) — you keep less on exit.`);
  if (transferPausable) reasons.push("Transfers can be paused by the owner (can freeze your exit).");
  if (sim.ran && sim.taxedOnTransfer) reasons.push("Transfers are taxed (confirmed by live simulation).");
  if (canExit === false) reasons.push("Pool too thin to exit this size without heavy slippage.");

  const level = !canSell ? "high" : sellTax !== null && sellTax >= 15 ? "medium" : transferPausable ? "medium" : "low";

  return {
    address: token,
    canSell,
    riskLevel: level, // low | medium | high
    honeypot,
    cannotSellAll,
    sellTaxPct: sellTax,
    buyTaxPct: buyTax,
    transferPausable,
    canExitSize: canExit,
    liveSimulation: sim, // our own transfer simulation result
    reasons,
    verdict: canSell
      ? sellTax !== null && sellTax >= 15
        ? "sellable_with_high_tax"
        : "sellable"
      : "do_not_buy_cannot_sell",
    note: "Combines security simulation, a live transfer simulation we run, and exit-liquidity. Simulate again before trading; state can change. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
