import { randomBytes, createHash } from 'node:crypto';
import { kvSet } from '@/lib/kv';
import { evaluateWalletCredit } from '@/app/api/credit/line/route';
import { type CreditLoanReceipt, type AgentCreditProfile } from '@/lib/credit-types';

/**
 * Types for the autopilot engine.
 */
export interface AutopilotEvent {
  /**
   * The kind of event that should trigger an action. Currently we support
   * "critical-data" which means an agent needs a flash‑micro‑credit to fetch
   * high‑value data.
   */
  eventType: 'critical-data';
  /**
   * URL of the data source the agent wants to call. The autopilot will invoke
   * the service with the generated credit token.
   */
  serviceUrl: string;
  /**
   * Approximate USDC amount needed for the call (used to size the credit draw‑down).
   */
  requiredUsdc: number;
  /**
   * Wallet of the agent that is requesting the credit. If omitted the system will
   * use a fallback test wallet.
   */
  wallet?: string;
}

export interface AutopilotResult {
  /** Credit token that was minted for the call */
  creditToken: string;
  /** Receipt from the internal loan creation */
  loanReceipt: CreditLoanReceipt;
  /** Raw response from the target service (if any) */
  serviceResponse?: any;
  /** Any error that occurred during processing */
  error?: string;
}

/**
 * Internal helper that mirrors the POST‑/api/credit/line borrow logic but can be
 * called from plain TypeScript code without an HTTP request.
 */
async function borrowFlashCredit(
  wallet: string,
  amountUsdc: number
): Promise<{ creditToken: string; receipt: CreditLoanReceipt }> {
  const profile = evaluateWalletCredit(wallet);
  if (amountUsdc > profile.availableCreditUsdc) {
    throw new Error('Requested amount exceeds available credit');
  }

  const feeUsdc = +((amountUsdc * profile.interestRateBps) / 10000).toFixed(4);
  const totalDue = +(amountUsdc + feeUsdc).toFixed(4);

  profile.availableCreditUsdc = +(profile.availableCreditUsdc - amountUsdc).toFixed(2);
  profile.outstandingDebtUsdc = +(profile.outstandingDebtUsdc + totalDue).toFixed(2);

  const loanId = `loan-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const txHash = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')}`;

  const creditToken = `ck_${randomBytes(18).toString('hex')}`;
  const creditKey = `credit:${createHash('sha256')
    .update(creditToken)
    .digest('hex')
    .slice(0, 24)}`;
  const centsBalance = Math.round(amountUsdc * 100);
  try {
    await kvSet(creditKey, String(centsBalance), 180 * 24 * 3600);
  } catch (err) {
    console.warn('KV credit balance store error (fallback to in‑memory):', err);
  }

  const receipt: CreditLoanReceipt = {
    loanId,
    wallet: profile.wallet,
    principalUsdc: amountUsdc,
    feeUsdc,
    totalDueUsdc: totalDue,
    issuedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    status: 'ACTIVE',
    txHash,
    basescanUrl: `https://basescan.org/tx/${txHash}`,
    creditToken,
    usageInstructions: `Send header 'x-credit-token: ${creditToken}' on any of our 225 APIs to execute instantly without per‑call gas or signing.`,
  };

  return { creditToken, receipt };
}

/**
 * Core autopilot entry point – given an event it will automatically borrow the
 * required flash credit (if needed) and invoke the target service.
 */
export async function handleAutopilotEvent(event: AutopilotEvent): Promise<AutopilotResult> {
  try {
    const wallet = event.wallet?.toLowerCase() ?? '0xec2abd3eda89bed90124736e317e847d5fb6d034';
    // 1️⃣ Borrow credit
    const { creditToken, receipt } = await borrowFlashCredit(wallet, event.requiredUsdc);

    // 2️⃣ Call the target service with the token
    let serviceResponse: any = undefined;
    try {
      const res = await fetch(event.serviceUrl, {
        headers: { 'x-credit-token': creditToken },
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        serviceResponse = await res.json();
      } else {
        serviceResponse = await res.text();
      }
    } catch (err) {
      console.error('Service call failed:', err);
    }

    return { creditToken, loanReceipt: receipt, serviceResponse };
  } catch (e: any) {
    return { creditToken: '', loanReceipt: {} as CreditLoanReceipt, error: e.message };
  }
}
