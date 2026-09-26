"use client";

/**
 * Swap across chains through NEAR Intents, for people. Wraps /api/swap/quote and
 * /api/swap/status: pick what you pay and what you want, say where the output
 * goes and where a refund goes, then send the quoted amount from your own
 * wallet to a one-time deposit address. Nothing to connect, nothing held by us.
 */

import { useEffect, useState } from "react";

/** Common pairs; the server resolves `SYMBOL@chain` against NEAR Intents' list. */
const ASSETS = [
  { v: "USDC", label: "USDC · NEAR" },
  { v: "USDT", label: "USDT · NEAR" },
  { v: "NEAR", label: "NEAR" },
  { v: "USDC@base", label: "USDC · Base" },
  { v: "ETH@base", label: "ETH · Base" },
  { v: "ETH@eth", label: "ETH · Ethereum" },
  { v: "USDC@eth", label: "USDC · Ethereum" },
  { v: "USDC@arb", label: "USDC · Arbitrum" },
  { v: "BTC@btc", label: "BTC · Bitcoin" },
  { v: "SOL@sol", label: "SOL · Solana" },
  { v: "USDC@sol", label: "USDC · Solana" },
] as const;

interface Quote {
  from: { symbol: string; chain: string };
  to: { symbol: string; chain: string };
  deposit: { address: string; memo: string | null; chain: string; asset: string; amount: string; sendBefore: string };
  amountOut: string;
  amountOutUsd: number | null;
  minAmountOut: string;
  amountInUsd: number | null;
  timeEstimateSec: number | null;
  distributionFeeBps: number;
  tokenSafety: { verdict: string; reasons: string[] } | null;
  next: string[];
}
interface Status {
  status: string;
  meaning: string | null;
  done: boolean;
  amountOut?: string | null;
  refunded?: string | null;
  refundReason?: string | null;
  destinationTxs?: string[];
}

const KEY = "x402-swap-pending";

function Copy({ label, value }: { label: string; value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-xl border border-base-line bg-black/60 p-3 text-[13px] text-sky-200">{value}</code>
        <button
          type="button"
          className="rounded-xl border border-base-line px-4 py-2 text-sm hover:border-emerald-400"
          onClick={() => {
            navigator.clipboard.writeText(value).then(() => {
              setOk(true);
              setTimeout(() => setOk(false), 1500);
            });
          }}
        >
          {ok ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function SwapClient() {
  const [from, setFrom] = useState("USDC");
  const [to, setTo] = useState("NEAR");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  // A pending swap survives a closed tab: the deposit address is how you check on it.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setQuote(JSON.parse(raw) as Quote);
    } catch {
      /* no storage */
    }
  }, []);

  useEffect(() => {
    if (!quote || status?.done) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/swap/status?depositAddress=${encodeURIComponent(quote.deposit.address)}`);
        const j = (await r.json()) as Status;
        if (!stop && r.ok) setStatus(j);
      } catch {
        /* try again next tick */
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [quote, status?.done]);

  async function getQuote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await fetch("/api/swap/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to, amount, recipient: recipient.trim(), refundTo: refundTo.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      setQuote(j as Quote);
      try {
        localStorage.setItem(KEY, JSON.stringify(j));
      } catch {
        /* no storage */
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setQuote(null);
    setStatus(null);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* no storage */
    }
  }

  const input = "w-full rounded-xl border border-base-line bg-black/50 px-3 py-2 text-sm outline-none focus:border-teal-400";

  if (quote) {
    const fresh = quote.deposit.chain === "near" && /^[0-9a-f]{64}$/.test(quote.deposit.address);
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-teal-500/30 bg-teal-500/5 p-5">
        <div className="text-sm text-gray-300">
          Send <strong className="text-white">exactly {quote.deposit.amount} {quote.deposit.asset}</strong> on{" "}
          <strong className="text-white">{quote.deposit.chain}</strong> from your own wallet. You get about{" "}
          <strong className="text-emerald-300">
            {Number(quote.amountOut).toPrecision(6)} {quote.to.symbol}
          </strong>{" "}
          on {quote.to.chain}
          {quote.amountOutUsd !== null ? ` (≈ $${quote.amountOutUsd.toFixed(2)})` : ""}, at least {Number(quote.minAmountOut).toPrecision(6)}.
        </div>
        <Copy label="Deposit address" value={quote.deposit.address} />
        {quote.deposit.memo && <Copy label="Memo (required)" value={quote.deposit.memo} />}
        <ul className="list-disc pl-5 text-xs text-gray-400">
          <li>Send before {new Date(quote.deposit.sendBefore).toLocaleString()}. Late or short deposits are refunded to your refund address.</li>
          <li>Send from a wallet you control, not an exchange withdrawal — exchanges deduct a fee and the deposit arrives short.</li>
          {fresh && <li>If your NEAR wallet says “account does not exist”, send 0.01 NEAR to the address first, then the {quote.deposit.asset}.</li>}
          <li>Includes a {quote.distributionFeeBps / 100}% service fee{quote.timeEstimateSec ? ` · usually done in ~${quote.timeEstimateSec}s after the deposit` : ""}.</li>
        </ul>
        {quote.tokenSafety && quote.tokenSafety.verdict !== "GO" && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            Token check: {quote.tokenSafety.verdict} — {quote.tokenSafety.reasons.join(" ")}
          </div>
        )}
        <div className="rounded-xl border border-base-line bg-black/40 p-3 text-sm">
          <span className="text-gray-500">Status: </span>
          <strong className={status?.status === "SUCCESS" ? "text-emerald-300" : "text-white"}>{status?.status ?? "checking…"}</strong>
          {status?.meaning && <span className="text-gray-400"> — {status.meaning}</span>}
          {status?.refunded && status.refunded !== "0" && <div className="text-xs text-amber-200">Refunded {status.refunded}{status.refundReason ? ` (${status.refundReason})` : ""}</div>}
          {status?.destinationTxs?.map((t) => (
            <div key={t} className="break-all text-xs text-sky-300">{t}</div>
          ))}
        </div>
        <button type="button" onClick={reset} className="w-fit rounded-xl border border-base-line px-4 py-2 text-sm hover:border-teal-400">
          {status?.done ? "New swap" : "Start over"}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={getQuote} className="flex flex-col gap-4 rounded-2xl border border-base-line bg-black/30 p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          You pay
          <select className={input} value={from} onChange={(e) => setFrom(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a.v} value={a.v}>{a.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Amount
          <input className={input} inputMode="decimal" placeholder="100" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          You get
          <select className={input} value={to} onChange={(e) => setTo(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a.v} value={a.v}>{a.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-gray-400">
        Receive at — your address on the chain you get
        <input className={input} placeholder="alice.near · 0x… · bc1…" value={recipient} onChange={(e) => setRecipient(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-400">
        Refund to — your address on the chain you pay from
        <input className={input} placeholder="used only if the swap cannot complete" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} required />
      </label>
      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div>}
      <button disabled={busy} className="w-fit rounded-xl bg-teal-500 px-5 py-2 text-sm font-semibold text-black hover:bg-teal-400 disabled:opacity-50">
        {busy ? "Getting a quote…" : "Get deposit address"}
      </button>
    </form>
  );
}
