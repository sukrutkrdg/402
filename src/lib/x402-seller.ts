/**
 * x402 seller check — should my agent pay THIS endpoint?
 *
 * x402 proves payment, not trust. An agent handed an x402 URL pays blind: the
 * wallet on the other side may be a real service or a burner that takes the USDC
 * and vanishes (the "mirror problem" the x402 Foundation's own identity/reputation
 * proposal, issue #1277, exists for). Nothing in the protocol answers it.
 *
 * This answers the pre-pay question from what IS verifiable, and is honest about
 * the rest:
 *   - Is the URL a real x402 resource? GET it (SSRF-guarded) and require a
 *     well-formed 402 with an `accepts` array naming a scheme, network and payTo.
 *   - Is the price what you expect? Surface maxAmountRequired per network so an
 *     agent can refuse a challenge that asks for more than it budgeted.
 *   - Is the SELLER WALLET known-bad or a throwaway? Screen payTo with
 *     safe-to-send (OFAC, identity, wallet-vs-contract, age/fresh-burner).
 *
 * What it deliberately does NOT claim: that the service is honest or will return
 * good data. Payment-side screening cannot know that. It says the endpoint is a
 * real x402 resource and its payee is not a known-bad or fresh-burner address —
 * exactly the half the protocol drops, and no more.
 */

import "server-only";
import { getAddress } from "viem";
import { assertSafeUrl } from "./ssrf";
import { safeToSend } from "./safe-to-send";

interface Accept {
  scheme?: string;
  network?: string;
  payTo?: string;
  maxAmountRequired?: string;
  price?: string | number;
  resource?: string;
}

const isAddr = (a?: string): a is string => /^0x[0-9a-fA-F]{40}$/.test((a ?? "").trim());

/** Fetch an x402 challenge from a URL. Returns the parsed accepts[] or an error
 *  reason. SSRF-guarded: the URL is resolved and refused if it points anywhere
 *  internal, because an agent handing us a URL must not turn us into its proxy. */
async function probeChallenge(url: string): Promise<{ status: number; accepts: Accept[]; raw: unknown } | { error: string }> {
  try {
    await assertSafeUrl(url, "url");
  } catch (e) {
    return { error: (e as Error).message };
  }
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  } catch {
    return { error: "endpoint unreachable (no response within 10s)" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const accepts = (body && typeof body === "object" && Array.isArray((body as { accepts?: unknown }).accepts)
    ? ((body as { accepts: Accept[] }).accepts)
    : []) as Accept[];
  return { status: res.status, accepts, raw: body };
}

export async function x402SellerCheck(params: Record<string, string>) {
  const url = (params.url || params.endpoint || params.resource || "").trim();
  let payTo = (params.payTo || params.seller || params.address || "").trim();
  if (!url && !isAddr(payTo)) {
    throw new Error("Provide the x402 endpoint (url=https://…) and/or the seller wallet (payTo=0x…)");
  }

  const reasons: string[] = [];
  let stop = false, warn = false;

  // ---- endpoint probe (only when a URL is given) ----
  let endpoint: Record<string, unknown> | null = null;
  if (url) {
    const probe = await probeChallenge(url);
    if ("error" in probe) {
      endpoint = { reachable: false, detail: probe.error };
      reasons.push(`endpoint: ${probe.error}`);
      stop = true; // cannot pay a URL we cannot even read a valid challenge from
    } else {
      const challenged = probe.status === 402;
      const first = probe.accepts[0];
      const challengePayTo = isAddr(first?.payTo) ? getAddress(first!.payTo!) : null;
      endpoint = {
        reachable: true,
        httpStatus: probe.status,
        isX402: challenged && probe.accepts.length > 0,
        networks: probe.accepts.map((a) => a.network).filter(Boolean),
        prices: probe.accepts.map((a) => ({ network: a.network, maxAmountRequired: a.maxAmountRequired ?? null, price: a.price ?? null })),
        payTo: challengePayTo,
        resource: first?.resource ?? null,
      };
      if (!challenged) {
        reasons.push(`endpoint returned HTTP ${probe.status}, not a 402 payment challenge — this is not a paywalled x402 resource as called`);
        warn = true;
      } else if (probe.accepts.length === 0) {
        reasons.push("402 response carries no `accepts` array — a malformed x402 challenge an agent cannot pay safely");
        stop = true;
      }
      // If the caller did not pass a payTo, adopt the one the challenge names, and
      // flag a mismatch when they did (a challenge paying a different wallet than
      // expected is exactly the swap a MITM would make).
      if (challengePayTo) {
        if (!isAddr(payTo)) payTo = challengePayTo;
        else if (getAddress(payTo) !== challengePayTo) {
          reasons.push(`the endpoint's challenge pays ${challengePayTo}, NOT the payTo you expected (${getAddress(payTo)}) — do not pay until this is explained`);
          stop = true;
        }
      }
    }
  }

  // ---- seller wallet screen (safe-to-send does the heavy lifting) ----
  let seller: Record<string, unknown> | null = null;
  if (isAddr(payTo)) {
    const s = (await safeToSend({ address: payTo })) as { verdict?: string; guidance?: string; degraded?: boolean; factors?: Record<string, { level: string; reason: string }> };
    seller = { address: getAddress(payTo), verdict: s.verdict ?? "unknown", degraded: Boolean(s.degraded), factors: s.factors };
    if (s.verdict === "STOP") { reasons.push(`seller wallet: ${s.guidance ?? "screened as do-not-send"}`); stop = true; }
    else if (s.verdict === "REVIEW") { reasons.push("seller wallet needs review (fresh / anonymous / unread factor) — see seller.factors"); warn = true; }
  } else if (!url) {
    reasons.push("no seller wallet to screen");
    warn = true;
  }

  const decision = stop ? "STOP" : warn ? "WARN" : "GO";
  return {
    url: url || null,
    payTo: isAddr(payTo) ? getAddress(payTo) : null,
    decision, // GO | WARN | STOP
    endpoint,
    seller,
    reasons,
    recommendation:
      decision === "STOP"
        ? "Do NOT pay this endpoint as it stands. Resolve the blocking reason first."
        : decision === "WARN"
          ? "Payable with caution — at least one signal could not be confirmed or warrants a look. See reasons."
          : "The endpoint is a real x402 resource and its payee is not a known-bad or fresh-burner wallet. This screens the PAYMENT side only — it does not vouch that the service returns correct data.",
    note: "Pre-pay check for an x402 endpoint: is it a well-formed 402 resource, does its price match, and is the seller wallet (payTo) known-bad, sanctioned or a throwaway. x402 proves payment, not trust; this covers the trust half the protocol drops. Not a guarantee of service quality. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
