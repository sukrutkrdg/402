"use client";

import { useState } from "react";
import StatusBar, { useStatus } from "./StatusBar";

export interface ServiceParamMeta {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
}

export interface ServiceMeta {
  id: string;
  name: string;
  tagline: string;
  description: string;
  price: string;
  icon: string;
  category: string;
  params: ServiceParamMeta[];
}

interface BuyResult {
  result: { data: unknown };
  payment: {
    txHash: string;
    network: string;
    payer?: string;
    price: string;
    appCode: string;
    clientCode: string;
  };
}

const BASESCAN_TX = (h: string) => `https://basescan.org/tx/${h}`;
const CHECKER = "https://buildercode-checker.vercel.app/";

function ServiceCard({ service }: { service: ServiceMeta }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<BuyResult | null>(null);

  async function buy() {
    setLoading(true);
    setError(null);
    setOut(null);
    try {
      const res = await fetch("/api/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: service.id, params }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setOut(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-base-line bg-black/40 text-xl">
            {service.icon}
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold leading-tight">{service.name}</h3>
              <span className="pill !px-2 !py-0.5 !text-[10px]">{service.category}</span>
            </div>
            <p className="text-xs text-gray-400">{service.tagline}</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-bold text-emerald-300">{service.price}</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">per call</div>
        </div>
      </div>

      <p className="text-[13px] leading-relaxed text-gray-400">{service.description}</p>

      {service.params.length > 0 && (
        <div className="flex flex-col gap-2">
          {service.params.map((p) => (
            <label key={p.name} className="flex flex-col gap-1">
              <span className="label">{p.label}</span>
              <input
                className="rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm outline-none focus:border-base-blue"
                placeholder={p.placeholder}
                value={params[p.name] ?? ""}
                onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      <button className="btn-primary" onClick={buy} disabled={loading}>
        {loading ? "Settling payment…" : `Pay ${service.price} & call`}
      </button>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {out && (
        <div className="flex flex-col gap-3 rounded-xl border border-base-line bg-black/30 p-3">
          <div>
            <div className="label mb-1">Response</div>
            <pre className="max-h-48 overflow-auto rounded-lg bg-black/50 p-3 text-[11px] leading-relaxed text-sky-200">
              {JSON.stringify(out.result.data, null, 2)}
            </pre>
          </div>

          <div>
            <div className="label mb-1.5">Onchain attribution (ERC-8021)</div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <span className="pill">
                a <code className="codechip">{out.payment.appCode}</code>
              </span>
              <span className="pill">
                w <code className="codechip">cdp_facil</code>
              </span>
              <span className="pill">
                s <code className="codechip">{out.payment.clientCode}</code>
              </span>
            </div>
          </div>

          {out.payment.txHash ? (
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <a
                className="text-sky-400 hover:underline"
                href={BASESCAN_TX(out.payment.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                View tx on BaseScan ↗
              </a>
              <a className="text-sky-400 hover:underline" href={CHECKER} target="_blank" rel="noreferrer">
                Verify in Builder Code checker ↗
              </a>
              <span className="font-mono text-gray-500">
                {out.payment.txHash.slice(0, 10)}…{out.payment.txHash.slice(-8)}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-amber-300">
              Settled, but no tx hash returned in the payment header.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Marketplace({ services }: { services: ServiceMeta[] }) {
  const status = useStatus();

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <span className="pill w-fit">⚡ x402 · Base mainnet · Builder Codes</span>
          <h1 className="max-w-2xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            A pay-per-call API marketplace where every payment is{" "}
            <span className="text-base-blue">attributed onchain</span>.
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
            Each service below is a real x402-protected endpoint. Calling one triggers a USDC
            micro-payment on Base, settled by the Coinbase facilitator. Your{" "}
            <strong className="text-gray-200">Builder Code</strong> is written into the settlement
            transaction&apos;s calldata (ERC-8021 Schema&nbsp;2) — so the traffic is attributed back
            to this app in the Base dashboard.
          </p>
        </div>
        <StatusBar status={status} />
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {services.map((s) => (
          <ServiceCard key={s.id} service={s} />
        ))}
      </section>
    </div>
  );
}
