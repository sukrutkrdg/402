/**
 * Bridge status — did the cross-chain transfer actually land?
 *
 * bridge-route starts a bridge; this is its other half. A bridge takes minutes
 * and the funds are in flight the whole time — an agent that fired one has no way
 * to know, from the source chain alone, whether it completed, is still pending,
 * or failed. This tracks it by the source tx hash through the LiFi status API
 * (the same aggregator bridge-route quotes), the way near-swap-status tracks a
 * NEAR Intents swap.
 *
 *   completed — funds delivered on the destination chain (with the receiving tx)
 *   pending   — still in flight; poll again
 *   failed    — the bridge failed; check substatus for why / recovery
 *   not_found — not a LiFi bridge tx, or too early to be indexed yet
 *   unknown   — the status API could not be read (never reported as a verdict)
 */

import "server-only";
import { CHAINS } from "./bridge-route";

const LIFI_STATUS = "https://li.quest/v1/status";

function chainParam(raw?: string): string | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  return CHAINS[s] ? String(CHAINS[s]) : null;
}

export async function bridgeStatus(params: Record<string, string>) {
  const txHash = (params.txHash || params.tx || params.hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Provide the source-chain transaction hash (txHash=0x… 32 bytes)");

  const qs = new URLSearchParams({ txHash });
  const from = chainParam(params.from || params.fromChain);
  const to = chainParam(params.to || params.toChain);
  const bridge = (params.bridge || params.tool || "").trim();
  if (from) qs.set("fromChain", from);
  if (to) qs.set("toChain", to);
  if (bridge) qs.set("bridge", bridge);

  let res: Response;
  try {
    res = await fetch(`${LIFI_STATUS}?${qs}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("Bridge status API unreachable (LiFi) — not charged, retry shortly.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    status?: string; substatus?: string; substatusMessage?: string; message?: string; code?: number;
    sending?: { txHash?: string; chainId?: number; amount?: string; token?: { symbol?: string; decimals?: number } };
    receiving?: { txHash?: string; chainId?: number; amount?: string; token?: { symbol?: string; decimals?: number } };
    tool?: string;
  };

  // A 404 / code 1003 means LiFi has no record of this tx as a bridge — either it
  // is not one, or it is too early to be indexed. That is a real answer, not a
  // failure, and must read as "not found", never "failed".
  if (res.status === 404 || body.code === 1003) {
    return {
      txHash,
      verdict: "not_found",
      detail: body.message || "No bridge event found for this transaction yet.",
      note: "LiFi has no bridge record for this tx — it is either not a bridge transfer, or too early to be indexed (retry in a minute). Not 'failed'. Not financial advice.",
      checkedAt: new Date().toISOString(),
    };
  }
  if (!res.ok || !body.status) {
    throw new Error(`Bridge status unavailable: ${body.message || `LiFi ${res.status}`} — not charged, retry shortly`);
  }

  const S = body.status.toUpperCase();
  const verdict = S === "DONE" ? "completed" : S === "PENDING" ? "pending" : S === "FAILED" ? "failed" : "unknown";
  const human = (leg?: { amount?: string; token?: { symbol?: string; decimals?: number } }) => {
    if (!leg?.amount || !leg.token?.decimals) return null;
    try { return `${Number(BigInt(leg.amount) * 1_000_000n / 10n ** BigInt(leg.token.decimals)) / 1_000_000} ${leg.token.symbol ?? ""}`.trim(); } catch { return null; }
  };

  return {
    txHash,
    verdict, // completed | pending | failed | unknown
    bridge: body.tool ?? null,
    substatus: body.substatus ?? null,
    substatusMessage: body.substatusMessage ?? null,
    sending: body.sending ? { chainId: body.sending.chainId ?? null, txHash: body.sending.txHash ?? null, amount: human(body.sending) } : null,
    receiving: body.receiving ? { chainId: body.receiving.chainId ?? null, txHash: body.receiving.txHash ?? null, amount: human(body.receiving) } : null,
    recommendation:
      verdict === "completed"
        ? `Done — funds delivered on the destination chain${human(body.receiving) ? ` (${human(body.receiving)})` : ""}. Safe to proceed.`
        : verdict === "pending"
          ? "Still in flight — bridges take minutes. Poll again shortly; do not re-send."
          : verdict === "failed"
            ? `The bridge FAILED${body.substatusMessage ? `: ${body.substatusMessage}` : ""}. Check the bridge's recovery flow before retrying — do not assume the funds are lost or safe without confirming.`
            : "Status could not be classified this call — treat as unknown, not done. Re-check.",
    note: "Tracks a cross-chain bridge transfer by its source tx hash via the LiFi status API — the destination half of bridge-route. Pass from/to/bridge if known for a faster lookup. A not-found reads as 'not indexed yet', never 'failed'. Not financial advice.",
    checkedAt: new Date().toISOString(),
  };
}
