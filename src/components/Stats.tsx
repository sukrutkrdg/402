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

interface UsageRow {
  id: string;
  name: string;
  total: number;
  paid: number;
  internal?: number;
  preview?: number;
  price?: number;
  revenue?: number;
  conversionPct?: number;
}
interface RecentCall {
  s: string;
  name?: string;
  p: boolean;
  t: number;
  src: string;
  k?: "browser" | "bot" | "api";
  ua?: string;
  ref?: string;
  /** First-party internal-auth call (our own product, e.g. Warden). */
  i?: boolean;
  /** Free-tier teaser (preview) response. */
  pv?: boolean;
}
interface Usage {
  per: UsageRow[];
  recent: RecentCall[];
  totalCalls: number;
  totalPaid: number;
  totalRevenue?: number;
  paidToday?: number;
  today: number;
  sourcesToday: number;
  botSourcesToday?: number;
  internalSourcesToday?: number;
  externalSourcesToday?: number;
  youSource?: string;
  ownerSources?: string[];
}

function timeAgo(t: number): string {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Stats() {
  const [data, setData] = useState<Revenue | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
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
      if (r.status === 401) {
        try {
          localStorage.removeItem("x402_stats_token");
        } catch {
          /* ignore */
        }
        throw new Error("Wrong password.");
      }
      if (!r.ok) throw new Error(j.error || j.note || "Failed to load");
      setData(j);
      setAuthed(true);
      // usage analytics (best-effort)
      try {
        const ur = await fetch(`/api/usage`, { headers: { "x-stats-token": tok } });
        if (ur.ok) setUsage(await ur.json());
      } catch {
        /* ignore */
      }
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

      {usage && (usage.totalCalls > 0 || usage.recent.length > 0) && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Usage &amp; activity</h2>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card p-4">
              <div className="label">Total calls</div>
              <div className="mt-1 font-mono text-2xl font-bold">{usage.totalCalls}</div>
              <div className="text-[10px] text-gray-500">
                {usage.totalCalls > 0 ? ((usage.totalPaid / usage.totalCalls) * 100).toFixed(1) : "0"}% paid
              </div>
            </div>
            <div className="card p-4">
              <div className="label">Est. revenue</div>
              <div className="mt-1 font-mono text-2xl font-bold text-emerald-300">
                ${(usage.totalRevenue ?? 0).toFixed(2)}
              </div>
              <div className="text-[10px] text-gray-500">
                {usage.totalPaid} paid · {usage.paidToday ?? 0} today
              </div>
            </div>
            <div className="card p-4">
              <div className="label">Real visitors today</div>
              <div className="mt-1 font-mono text-2xl font-bold text-sky-300">
                {usage.externalSourcesToday ?? usage.sourcesToday}
              </div>
              <div className="text-[10px] text-gray-500">excl. you &amp; bots</div>
            </div>
            <div className="card p-4">
              <div className="label">Sources today</div>
              <div className="mt-1 font-mono text-2xl font-bold">{usage.sourcesToday}</div>
              <div className="text-[10px] text-gray-500">
                all · {usage.botSourcesToday ?? 0} bots
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-base-line/60 bg-black/20 px-3 py-2 text-[11px] text-gray-400">
            {usage.totalPaid > 0
              ? "💰 You have PAID calls — real agents are paying. Genuine traction."
              : (usage.externalSourcesToday ?? 0) > 0
                ? `👀 ${usage.externalSourcesToday} real visitor${(usage.externalSourcesToday ?? 0) > 1 ? "s" : ""} today (not you, not bots) tried it for free. Real interest — watch 'Paid' next.`
                : "🧪 Today's traffic is just you / bots / crons. Share the link + outreach to get real visitors."}
          </div>
          {usage.youSource && (
            <p className="text-[10px] text-gray-500">
              You (this device) ={" "}
              <span className="font-mono text-gray-300">{usage.youSource}</span> · calls from this src
              are marked <span className="text-amber-300">you</span> below. Add other devices via the{" "}
              <span className="font-mono">OWNER_SOURCES</span> env to exclude them from “real visitors”.
            </p>
          )}

          {usage.recent.length > 0 && (
            <div>
              <div className="label mb-1.5">Recent activity</div>
              <div className="card max-h-64 divide-y divide-base-line/60 overflow-auto">
                {usage.recent.map((r, i) => {
                  const isYou =
                    r.src === usage.youSource || (usage.ownerSources ?? []).includes(r.src);
                  const isBot = r.k === "bot";
                  const who = isYou
                    ? { label: "you", cls: "bg-amber-500/15 text-amber-300" }
                    : r.i
                      ? { label: "internal", cls: "bg-violet-500/15 text-violet-300" }
                      : isBot
                        ? { label: "bot", cls: "bg-white/5 text-gray-500" }
                        : { label: "visitor", cls: "bg-sky-500/15 text-sky-300" };
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            r.p
                              ? "bg-emerald-500/15 text-emerald-300"
                              : r.pv
                                ? "bg-sky-500/15 text-sky-300"
                                : "bg-white/5 text-gray-400"
                          }`}
                        >
                          {r.p ? "PAID" : r.pv ? "preview" : "free"}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${who.cls}`}>
                          {who.label}
                        </span>
                        <span className="truncate">{r.name ?? r.s}</span>
                        {r.ua && (
                          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-gray-400">
                            {r.ua}
                          </span>
                        )}
                        {r.ref && (
                          <span className="shrink-0 truncate text-[10px] text-violet-300/80">
                            ← {r.ref}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-gray-500">
                        <span className="font-mono">src {r.src}</span>
                        <span>{timeAgo(r.t)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-gray-500">
                “src” = pseudonymous caller id (hashed IP). Same src across calls = same caller (likely you).
              </p>
            </div>
          )}

          {usage.per.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <div className="label">By service</div>
                {typeof usage.totalRevenue === "number" && (
                  <div className="text-xs">
                    <span className="text-gray-500">Est. revenue </span>
                    <span className="font-mono font-bold text-emerald-300">${usage.totalRevenue.toFixed(2)}</span>
                  </div>
                )}
              </div>
              <div className="card divide-y divide-base-line/60">
                {usage.per.map((r) => {
                  const free = r.total - r.paid - (r.internal ?? 0);
                  const conv = r.conversionPct ?? 0;
                  const convCls =
                    conv >= 20 ? "text-emerald-300" : conv >= 5 ? "text-amber-300" : "text-gray-500";
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1 truncate text-sm">{r.name}</div>
                      <div className="flex shrink-0 items-center gap-2.5 text-xs">
                        {r.revenue ? (
                          <span className="font-mono font-semibold text-emerald-300">${r.revenue.toFixed(2)}</span>
                        ) : null}
                        <span className={`w-10 text-right font-mono ${convCls}`} title="conversion: paid ÷ external calls">
                          {conv}%
                        </span>
                        <span className="text-emerald-300/90">{r.paid}p</span>
                        {r.preview ? <span className="text-sky-300/80">{r.preview}👁</span> : null}
                        <span className="text-gray-500">{free}f</span>
                        {r.internal ? <span className="text-violet-300/70">{r.internal}i</span> : null}
                        <span className="w-8 text-right font-mono font-bold">{r.total}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-gray-500">
                <span className="text-emerald-300">$</span> est. revenue (paid×price) ·{" "}
                <span className="text-emerald-300">%</span> conversion (paid ÷ external) ·{" "}
                <b>p</b> paid · <b>👁</b> preview/teaser · <b>f</b> free · <b>i</b> internal
              </p>
            </div>
          )}
          <p className="text-[11px] text-gray-500">Durable analytics require KV (UPSTASH_REDIS_REST_URL/TOKEN).</p>
        </section>
      )}

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
