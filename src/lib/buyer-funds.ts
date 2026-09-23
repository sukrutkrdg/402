/**
 * Can the keepalive still pay?
 *
 * `buyer-funds` has been in ALERT_KINDS for weeks and nothing ever raised it.
 * Not a detector that went unread — a detector that was never written, with
 * only its name in place. The codebase already carries this exact lesson from
 * the Anthropic outage of 2026-08-20 ("a detector nobody reads is not a
 * detector"); this is the version where there was nothing to read.
 *
 * It cost two silent days. The buyer wallet ran dry after the 03:00 run on
 * 2026-09-21, and the runs on the 22nd and 23rd settled nothing at all. The
 * cron reported `refreshed: 0` and `ok`, which is indistinguishable from a
 * morning where everything was already fresh — so the failure looked exactly
 * like a healthy day.
 *
 * WHAT IS AND IS NOT AT STAKE
 * ---------------------------
 * This wallet is ours. It does NOT gate customers: an external buyer pays from
 * their own wallet and is unaffected. What it gates is the keepalive, and
 * therefore discovery — a listing leaves the Bazaar's rolling window about
 * thirty days after its last settled payment. So an empty buyer wallet is not
 * an outage, it is a slow disappearance, which is why nobody notices and why it
 * needs an alarm rather than a dashboard.
 */

import "server-only";
import { createPublicClient, http, erc20Abi, formatUnits, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import { USDC_BASE } from "./config";
import { getBuyerAddress } from "./x402-client";
import { baseTransport } from "./base-transport";

/**
 * A single run can spend the per-run cap (60c) plus one over-cap purchase that
 * the cap deliberately exempts — the dearest service is 75c. So $1.35 is the
 * worst case for one morning, and this warns with roughly a run in hand rather
 * than at the moment it stops working.
 */
export const LOW_BALANCE_USD = 2;

export interface BuyerFunds {
  address: string;
  usdc: number;
  /** Below the worst case for a single run — top up before the next one. */
  low: boolean;
  /** Cannot settle even the cheapest service. The keepalive is already dead. */
  empty: boolean;
  reason: string;
}

/**
 * Read the buyer's USDC balance. Returns null when there is no buyer
 * configured (a deployment that never settles its own payments) or when the
 * read fails — unknown is not "empty", and raising an incident from a failed
 * RPC call would be the false alarm this exists to avoid.
 */
export async function checkBuyerFunds(): Promise<BuyerFunds | null> {
  const address = getBuyerAddress();
  if (!address) return null;
  try {
    const client = createPublicClient({ chain: base, transport: baseTransport(8000) });
    const raw = (await client.readContract({
      address: USDC_BASE as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(address)],
    })) as bigint;
    const usdc = Number(formatUnits(raw, 6));
    // The cheapest thing we sell is a tenth of a cent; below that no settlement
    // of any kind can complete.
    const empty = usdc < 0.002;
    const low = usdc < LOW_BALANCE_USD;
    return {
      address,
      usdc: +usdc.toFixed(4),
      low,
      empty,
      reason: empty
        ? `The keepalive buyer wallet holds $${usdc.toFixed(4)} and cannot settle anything. Every listing leaves the discovery index about thirty days after its last settled payment, so this is a slow disappearance rather than an outage — customers paying from their own wallets are unaffected.`
        : low
          ? `The keepalive buyer wallet is down to $${usdc.toFixed(2)}. One run can need up to $1.35, so the next morning may settle only part of its list.`
          : `$${usdc.toFixed(2)} — enough for the next runs.`,
    };
  } catch {
    return null;
  }
}
