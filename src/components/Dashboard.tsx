"use client";

import { useEffect, useState } from "react";

interface Attribution {
  app: string | null;
  wallet: string | null;
  service: string[];
}

interface AttributionResponse {
  hash: string;
  found: boolean;
  attribution: Attribution | null;
  tx: { from: string; to: string | null; blockNumber: string | null };
}

interface PaymentRecord {
  id: string;
  serviceName: string;
  price: string;
  txHash: string;
  appCode: string;
  clientCode: string;
  createdAt: string;
}

const BASESCAN_TX = (h: string) => `https://basescan.org/tx/${h}`;
const CHECKER = "https://buildercode-checker.vercel.app/";

function CodeRow({ k, label, value }: { k: string; label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-base-line/60 py-2 last:border-0">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-base-blue/20 font-mono text-xs font-bold text-base-blue">
          {k}
        </span>
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      {value ? (
        <code className="codechip">{value}</code>
      ) : (
        <span className="text-xs text-gray-600">not set</span>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [hash, setHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AttributionResponse | null>(null);
  const [recent, setRecent] = useState<PaymentRecord[]>([]);

  async function loadRecent() {
    try {
      const r = await fetch("/api/payments");
      const j = await r.json();
      setRecent(j.payments ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadRecent();
  }, []);

  async function lookup(h?: string) {
    const target = (h ?? hash).trim();
    if (!target) return;
    setHash(target);
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const r = await fetch(`/api/attribution?hash=${encodeURIComponent(target)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Lookup failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🔎 Onchain verification</span>
        <h1 className="text-3xl font-bold tracking-tight">Attribution Dashboard</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          Paste any Base settlement transaction hash. We read its calldata and decode the ERC-8021
          Schema&nbsp;2 Builder Code suffix — the same data the Base dashboard uses to attribute x402
          traffic. No database, no trust: it&apos;s all onchain.
        </p>
      </section>

      <section className="card flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="flex-1 rounded-lg border border-base-line bg-black/40 px-3 py-2.5 font-mono text-sm outline-none focus:border-base-blue"
            placeholder="0x… settlement transaction hash"
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookup()}
          />
          <button className="btn-primary" onClick={() => lookup()} disabled={loading}>
            {loading ? "Reading chain…" : "Decode attribution"}
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-4 rounded-xl border border-base-line bg-black/30 p-4">
            {data.found && data.attribution ? (
              <>
                <div className="flex items-center gap-2 text-sm text-emerald-300">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> Builder Code suffix found
                </div>
                <div>
                  <CodeRow k="a" label="App (service endpoint)" value={data.attribution.app} />
                  <CodeRow k="w" label="Wallet (facilitator)" value={data.attribution.wallet} />
                  <CodeRow
                    k="s"
                    label="Service (client)"
                    value={data.attribution.service.length ? data.attribution.service.join(", ") : null}
                  />
                </div>
              </>
            ) : (
              <div className="text-sm text-amber-300">
                No ERC-8021 Builder Code suffix found in this transaction&apos;s calldata.
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
              <span>
                from <span className="font-mono text-gray-300">{data.tx.from}</span>
              </span>
              {data.tx.blockNumber && <span>block {data.tx.blockNumber}</span>}
              <a className="text-sky-400 hover:underline" href={BASESCAN_TX(data.hash)} target="_blank" rel="noreferrer">
                BaseScan ↗
              </a>
              <a className="text-sky-400 hover:underline" href={CHECKER} target="_blank" rel="noreferrer">
                Coinbase checker ↗
              </a>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent settlements</h2>
          <button className="btn-ghost !px-3 !py-1.5 !text-xs" onClick={loadRecent}>
            Refresh
          </button>
        </div>
        {recent.length === 0 ? (
          <div className="card px-4 py-8 text-center text-sm text-gray-500">
            No payments yet. Buy something in the{" "}
            <a className="text-sky-400 hover:underline" href="/">
              marketplace
            </a>{" "}
            to see it appear here.
          </div>
        ) : (
          <div className="card divide-y divide-base-line/60">
            {recent.map((p) => (
              <button
                key={p.id}
                onClick={() => lookup(p.txHash)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-white/5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.serviceName}</div>
                  <div className="truncate font-mono text-[11px] text-gray-500">{p.txHash}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <code className="codechip hidden sm:inline">{p.appCode}</code>
                  <span className="font-mono text-xs text-emerald-300">{p.price}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
