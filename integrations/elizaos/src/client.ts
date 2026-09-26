/**
 * The x402 Bazaar HTTP client both integrations share (this file is copied
 * verbatim into each package so each installs on its own).
 *
 * Payment, in order: a prepaid credit token (one header, no signing); else an
 * x402 payment signed by the agent's own wallet; else the free daily call.
 * Funds for swaps never touch this code's server: base swaps are sent by the
 * agent's wallet, cross-chain swaps are deposits to NEAR Intents.
 */

export const DEFAULT_BASE_URL = "https://402.com.tr";
/** Base Builder Code (ERC-8021) echoed on wallet payments so settlements are attributed. */
export const BUILDER_CODE = "bc_pa0gqlv1";

export interface TypedDataSigner {
  address: `0x${string}`;
  signTypedData: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
}

export interface BazaarClientOptions {
  baseUrl?: string;
  /** Prepaid credit token (ck_…) — buy once at https://402.com.tr/credits. */
  creditToken?: string;
  /** Pay per call from this wallet over x402 when there is no credit token. */
  signer?: TypedDataSigner;
}

export class BazaarClient {
  readonly baseUrl: string;
  private payingFetch: typeof fetch | null = null;

  constructor(private opts: BazaarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async pay(): Promise<typeof fetch> {
    if (this.payingFetch) return this.payingFetch;
    const [{ x402Client, wrapFetchWithPayment }, { ExactEvmScheme }, { BuilderCodeClientExtension }] = await Promise.all([
      import("@x402/fetch"),
      import("@x402/evm/exact/client"),
      import("@x402/extensions/builder-code"),
    ]);
    const client = new x402Client();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.register("eip155:8453", new ExactEvmScheme(this.opts.signer as any));
    client.registerExtension(new BuilderCodeClientExtension(BUILDER_CODE));
    this.payingFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
    return this.payingFetch;
  }

  /** Call a paid endpoint: GET /api/x402/<service>?<params>. Returns the `data` payload. */
  async call<T = Record<string, unknown>>(service: string, params: Record<string, string | number | undefined>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.baseUrl}/api/x402/${encodeURIComponent(service)}?${qs}`;
    let res: Response;
    if (this.opts.creditToken) {
      res = await fetch(url, { headers: { "x-credit-token": this.opts.creditToken } });
    } else if (this.opts.signer) {
      res = await (await this.pay())(url);
    } else {
      res = await fetch(url, { headers: { "x-402-free": "1" } });
    }
    const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string; preview?: boolean; unlock?: string };
    if (!res.ok) throw new Error(body.error || `${service} answered ${res.status}`);
    if (body.preview) throw new Error(body.unlock || `${service}: free call used — set a credit token or a wallet to pay`);
    return (body.data ?? body) as T;
  }
}

/** A NEAR Intents asset on Base, as the ERC-20 (or native ETH) the agent's wallet sends. */
export function baseOriginToken(assetId: string): { native: true } | { native: false; address: `0x${string}` } | null {
  if (/^nep141:base\.omft\.near$/i.test(assetId)) return { native: true };
  const m = /^nep141:base-(0x[0-9a-fA-F]{40})\.omft\.near$/.exec(assetId);
  return m ? { native: false, address: m[1] as `0x${string}` } : null;
}

export interface BaseSwapQuote {
  sell: { symbol: string; address: string; amount: string; amountBaseUnits: string };
  buy: { symbol: string; amount: string | null; minAmount: string | null };
  route: { source: string; sharePct: number }[];
  fees: Record<string, unknown>;
  needsApproval: { token: string; spender: string } | null;
  insufficientBalance: boolean;
  transaction: { to: string; data: string; value: string; gas: string | null };
}

export interface NearSwapQuote {
  from: { assetId: string; symbol: string; chain: string };
  to: { assetId: string; symbol: string; chain: string };
  deposit: { address: string; memo: string | null; chain: string; asset: string; amount: string; amountBaseUnits: string; sendBefore: string };
  amountOut: string;
  minAmountOut: string;
  next: string[];
}
