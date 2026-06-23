"use client";

import { useEffect, useState } from "react";

interface Payment {
  from: string;
  amountUsdc: string;
  txHash: string;
  block: string;
}
interface Revenue {
  payTo: string | null;
  windowBlocks: number;
  count: number;
  totalUsdc: string;
  payments: Payment[];
  rpcLimited?: boolean;
  note?: string;
}

const BASESCAN_TX = (h: string) => `https://basescan.org/tx/${h}`;
const BASESCAN_TOKENTX = (a: string) => `https://basescan.org/address/${a}#tokentxns`;
const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export default function Stats() {
  const [data, setData] = useState<Revenue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);

  async function load(tok: string) {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/revenue?blocks=4000`, { headers: { "x-stats-token": tok } });
      const j = await r.json();
      if (r.status === 401) throw new Error("Wrong password.");
      if (!r.ok) throw new Error(j.error || j.note || "Failed to load");
      setData(j);
      setAuthed(true);
      try {
        localStorage.setItem("x402_stats_token", tok);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setAuthed(false);
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem("x402_stats_token") || "";
    } catch {
      /* ignore */
    }
    if (saved) {
      setToken(saved);
      load(saved);
    }
  }, []);

  // Locked gate — owner enters the STATS_TOKEN password.
  if (!authed) {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col gap-4">
        <span className="pill w-fit">🔒 Private</span>
        <h1 className="text-2xl font-bold tracking-tight">Revenue dashboard</h1>
        <p className="text-sm text-gray-400">
          Owner only. Enter the access password (the <code className="codechip">STATS_TOKEN</code> you
          set in the environment).
        </p>
        <input
          type="password"
          className="rounded-lg border border-base-line bg-black/40 px-3 py-2.5 text-sm outline-none focus:border-base-blue"
          placeholder="Access password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token && load(token)}
        />
        <button className="btn-primary" onClick={() => token && load(token)} disabled={loading || !token}>
          {loading ? "Checking…" : "Unlock"}
        </button>
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
    );
  }

  function load0() {
    load(token);
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">💰 Revenue</span>
        <h1 className="text-3xl font-bold tracking-tight">Your earnings, onchain</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          Real agent purchases are USDC payments into your seller wallet on Base. This shows recent
          ones read live from chain. For the complete, authoritative history, open your wallet on
          BaseScan.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <div className="label">Received (recent window)</div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-300">
            {data ? `$${data.totalUsdc}` : "—"}
          </div>
          <div className="text-[11px] text-gray-500">USDC · last ~{data?.windowBlocks ?? 0} blocks</div>
        </div>
        <div className="card p-5">
          <div className="label">Payments</div>
          <div className="mt-1 font-mono text-2xl font-bold">{data?.count ?? "—"}</div>
          <div className="text-[11px] text-gray-500">incoming USDC transfers</div>
        </div>
        <div className="card p-5">
          <div className="label">Seller wallet</div>
          <div className="mt-1 font-mono text-sm">{short(data?.payTo ?? "")}</div>
          {data?.payTo && (
            <a
              className="text-[11px] text-sky-400 hover:underline"
              href={BASESCAN_TOKENTX(data.payTo)}
              target="_blank"
              rel="noreferrer"
            >
              Full history on BaseScan ↗
            </a>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent payments</h2>
          <button className="btn-ghost !px-3 !py-1.5 !text-xs" onClick={load0}>
            Refresh
          </button>
        </div>

        {loading && <div className="card animate-pulse px-4 py-8 text-center text-sm text-gray-500">Reading chain…</div>}
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
        )}
        {data?.rpcLimited && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {data.note}
          </div>
        )}

        {data && !loading && data.payments.length === 0 && !data.rpcLimited && (
          <div className="card px-4 py-8 text-center text-sm text-gray-500">
            No payments in this window yet. When agents call your paid endpoints, USDC lands here —
            and on{" "}
            {data.payTo && (
              <a className="text-sky-400 hover:underline" href={BASESCAN_TOKENTX(data.payTo)} target="_blank" rel="noreferrer">
                BaseScan
              </a>
            )}
            .
          </div>
        )}

        {data && data.payments.length > 0 && (
          <div className="card divide-y divide-base-line/60">
            {data.payments.map((p) => (
              <div key={p.txHash} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm">
                    from <span className="font-mono">{short(p.from)}</span>
                  </div>
                  <a
                    className="truncate font-mono text-[11px] text-sky-400 hover:underline"
                    href={BASESCAN_TX(p.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.txHash.slice(0, 18)}…
                  </a>
                </div>
                <div className="shrink-0 font-mono text-sm font-bold text-emerald-300">${p.amountUsdc}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card flex flex-col gap-2 p-5 text-xs text-gray-400">
        <div className="label">Where to see everything</div>
        <p>
          • <strong className="text-gray-200">This page</strong> — recent incoming USDC (live from chain).
        </p>
        <p>
          • <strong className="text-gray-200">BaseScan</strong> — complete payment history for your wallet.
        </p>
        <p>
          • <strong className="text-gray-200">dashboard.base.org</strong> — Builder Code analytics (x402 traffic attributed to your app).
        </p>
        <p className="text-gray-500">
          Note: x402 is stateless request→pay→response — there is no chat channel with agents. The
          payment (here / onchain) plus the called endpoint is the record. Per-request service-level
          analytics would need a KV-backed log (next step if you want it).
        </p>
      </section>
    </div>
  );
}
