"use client";

/**
 * Buy a credit pack from NEAR (or any chain NEAR Intents routes) — for people
 * whose money is not USDC on Base. Wraps /api/credits/near/quote and /status:
 * pick a pack and an asset, send the quoted amount to a one-time deposit
 * address from your own wallet, and the token appears here when the swap
 * settles. See src/lib/near-intents.ts for the server side.
 */

import { useEffect, useState } from "react";

interface Tier {
  tier: string;
  usd: number;
  credits: number;
}

/** The assets most NEAR wallets hold. Anything else: paste its 1Click asset id. */
const ASSETS = [
  { id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", label: "USDC on NEAR", hint: "cheapest — stable to stable" },
  { id: "nep141:usdt.tether-token.near", label: "USDT on NEAR", hint: "stable to stable" },
  { id: "nep141:wrap.near", label: "NEAR (wNEAR)", hint: "priced at the quote" },
] as const;
const CUSTOM = "custom";

interface Order {
  orderId: string;
  orderSecret: string;
  tier: string;
  creditsUsd: number;
  assetLabel: string;
  pay: {
    depositAddress: string;
    depositMemo?: string;
    amountInFormatted: string;
    minAmountIn: string;
    deadline?: string;
    timeEstimateSec?: number;
  };
}

interface Claimed {
  creditToken: string;
  balanceUsd?: number;
  settlement?: { hash: string; explorerUrl: string }[];
}

// The pending order holds the only key that claims a paid balance, so it must
// outlive a closed tab: someone may send the deposit, close the page, and come
// back. localStorage, cleared once the token has been shown and saved.
const PENDING = "x402-near-order";
const IMPLICIT_WITH_SUFFIX = /^[0-9a-f]{64}\.near$/;
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function load(): Order | null {
  try {
    const raw = localStorage.getItem(PENDING);
    return raw ? (JSON.parse(raw) as Order) : null;
  } catch {
    return null;
  }
}
function save(o: Order | null) {
  try {
    if (o) localStorage.setItem(PENDING, JSON.stringify(o));
    else localStorage.removeItem(PENDING);
  } catch {
    /* storage unavailable — the order stays on screen */
  }
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl border border-base-line bg-black/60 p-3 text-[13px] text-sky-200">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-xl border border-base-line px-4 py-2 text-sm hover:border-emerald-400"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function NearCreditsClient({ tiers }: { tiers: Tier[] }) {
  const [tier, setTier] = useState(tiers[0]?.tier ?? "1");
  const [asset, setAsset] = useState<string>(ASSETS[0].id);
  const [customAsset, setCustomAsset] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Claimed | null>(null);

  useEffect(() => setOrder(load()), []);

  // Poll while an order is open. 1Click settles in tens of seconds once the
  // deposit lands; every 5s is what its own docs suggest.
  useEffect(() => {
    if (!order || claimed) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/credits/near/status?orderId=${order.orderId}`, {
          headers: { "x-order-secret": order.orderSecret },
          cache: "no-store",
        });
        const j = (await r.json()) as { status?: string; error?: string } & Partial<Claimed>;
        if (stop) return;
        if (!r.ok) {
          setError(j.error ?? `Status check failed (${r.status})`);
          return;
        }
        setStatus(j.status ?? null);
        if (j.status === "SUCCESS" && j.creditToken) {
          setClaimed({ creditToken: j.creditToken, balanceUsd: j.balanceUsd, settlement: j.settlement });
        }
      } catch {
        /* transient — the next tick retries */
      }
    };
    tick();
    const id = setInterval(() => {
      if (status && TERMINAL.has(status)) return;
      tick();
    }, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [order, claimed, status]);

  const originAsset = asset === CUSTOM ? customAsset.trim() : asset;
  const suffixMistake = IMPLICIT_WITH_SUFFIX.test(refundTo.trim());

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/credits/near/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier, originAsset, refundTo: refundTo.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Quote failed (${r.status})`);
      const o: Order = {
        ...j,
        assetLabel: ASSETS.find((a) => a.id === originAsset)?.label ?? originAsset,
      };
      save(o);
      setOrder(o);
      setStatus("PENDING_DEPOSIT");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    save(null);
    setOrder(null);
    setClaimed(null);
    setStatus(null);
    setError(null);
  }

  // ── token claimed ──────────────────────────────────────────────────────
  if (claimed) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5">
        <h2 className="text-lg font-semibold text-emerald-300">
          {claimed.balanceUsd !== undefined ? `$${claimed.balanceUsd.toFixed(2)} credit is live` : "Credit is live"} · paid from NEAR
        </h2>
        <CopyRow label="Your credit token — save it now" value={claimed.creditToken} />
        {claimed.settlement?.[0] && (
          <a className="text-xs text-sky-400 hover:underline" href={claimed.settlement[0].explorerUrl} target="_blank" rel="noreferrer">
            Settlement on Base ↗
          </a>
        )}
        <p className="text-xs text-gray-500">
          Send it as the <code className="text-sky-300">x-credit-token</code> header on any call. Lost it? Until
          you press done, this page can fetch it again; after that, the same order id and order secret return it
          from <code className="text-sky-300">/api/credits/near/status</code>.
        </p>
        {order && <CopyRow label="Order secret (recovers the token)" value={order.orderSecret} />}
        <button
          type="button"
          onClick={reset}
          className="w-fit rounded-xl border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-300 hover:border-emerald-400"
        >
          I&apos;ve saved it — done
        </button>
      </div>
    );
  }

  // ── order open: pay and wait ─────────────────────────────────────────────
  if (order) {
    const refunded = status === "REFUNDED" || status === "FAILED";
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-base-line bg-black/30 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Send {order.pay.amountInFormatted} {order.assetLabel} → ${order.creditsUsd.toFixed(2)} of credit
          </h2>
          <span className="pill">{status ?? "…"}</span>
        </div>
        {error && <p className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">{error}</p>}
        <CopyRow label="Deposit address" value={order.pay.depositAddress} />
        {order.pay.depositMemo && <CopyRow label="Memo (required)" value={order.pay.depositMemo} />}
        <CopyRow label="Amount" value={order.pay.amountInFormatted} />
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-gray-400">
          <li>Send from your own wallet, on the asset&apos;s own chain{order.pay.deadline ? `, before ${new Date(order.pay.deadline).toLocaleString()}` : ""}.</li>
          <li>The amount includes a ~1% buffer; whatever the swap does not use is returned to your refund address.</li>
          <li>If your wallet asks to register the receiving account for the token, approve it (a tiny one-off NEAR fee).</li>
          <li>This page checks every few seconds — you can close it and come back; the order is remembered in this browser.</li>
        </ul>
        {refunded && (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-200">
            The swap did not complete, so no credit was issued. NEAR Intents returns the deposit to your refund address.
          </p>
        )}
        <CopyRow label="Order secret — keep it until your token arrives" value={order.orderSecret} />
        <button type="button" onClick={reset} className="w-fit text-xs text-gray-500 underline hover:text-gray-300">
          {refunded ? "Start a new order" : "Cancel (only if you have not sent anything)"}
        </button>
      </div>
    );
  }

  // ── choose ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-base-line bg-black/30 p-5">
      <div>
        <h2 className="text-sm font-semibold">Pay from NEAR — or any chain NEAR Intents reaches</h2>
        <p className="mt-1 text-xs text-gray-500">
          No USDC on Base? Pay with USDC, USDT or NEAR from a NEAR wallet (or BTC, SOL and more by asset id). NEAR
          Intents swaps it to USDC on Base for us and you get the same credit token — no wallet connection needed.
        </p>
      </div>
      {error && <p className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {tiers.map((t) => (
          <button
            key={t.tier}
            type="button"
            onClick={() => setTier(t.tier)}
            className={`rounded-xl border px-4 py-2 text-sm ${tier === t.tier ? "border-emerald-400 text-emerald-300" : "border-base-line hover:border-gray-500"}`}
          >
            ${t.usd.toFixed(2)}
            {t.credits > t.usd * 100 && <span className="text-emerald-400"> +{((t.credits - t.usd * 100) / 100).toFixed(2)}</span>}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-xs text-gray-400">
        Pay with
        <select
          value={asset}
          onChange={(e) => setAsset(e.target.value)}
          className="rounded-xl border border-base-line bg-black/60 p-2.5 text-sm text-gray-200"
        >
          {ASSETS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} — {a.hint}
            </option>
          ))}
          <option value={CUSTOM}>Other asset (paste its NEAR Intents id)</option>
        </select>
      </label>
      {asset === CUSTOM && (
        <input
          value={customAsset}
          onChange={(e) => setCustomAsset(e.target.value)}
          placeholder="e.g. nep141:sol.omft.near — list at 1click.chaindefuser.com/v0/tokens"
          className="rounded-xl border border-base-line bg-black/60 p-2.5 text-sm text-gray-200"
        />
      )}

      <label className="flex flex-col gap-1 text-xs text-gray-400">
        Refund address (your account on the chain you pay from)
        <input
          value={refundTo}
          onChange={(e) => setRefundTo(e.target.value)}
          placeholder="alice.near or a 64-character implicit account"
          className="rounded-xl border border-base-line bg-black/60 p-2.5 text-sm text-gray-200"
        />
      </label>
      {suffixMistake && (
        <p className="text-xs text-amber-300">
          A 64-character NEAR account has no <code>.near</code> suffix — use{" "}
          <button type="button" className="underline" onClick={() => setRefundTo(refundTo.trim().slice(0, 64))}>
            {refundTo.trim().slice(0, 8)}…{refundTo.trim().slice(56, 64)}
          </button>
          .
        </p>
      )}

      <button
        type="button"
        onClick={create}
        disabled={busy || !originAsset || !refundTo.trim() || suffixMistake}
        className="btn-primary w-fit disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Getting a quote…" : "Get deposit address"}
      </button>
    </div>
  );
}
