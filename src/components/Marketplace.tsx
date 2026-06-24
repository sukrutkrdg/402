"use client";

import { useEffect, useState } from "react";
import StatusBar, { useStatus } from "./StatusBar";

export interface ServiceParamMeta {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
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

// Category display order — earlier index = rendered first.
const CATEGORY_ORDER = ["Onchain", "AI", "Markets", "Data", "Fun", "Utility"];

const TRUST_PILLS = [
  { label: "USDC on Base" },
  { label: "No API keys" },
  { label: "x402 protocol" },
  { label: "MCP-ready" },
];

function ServiceCard({
  service,
  buyerEnabled,
  token,
}: {
  service: ServiceMeta;
  buyerEnabled: boolean;
  token: string;
}) {
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
        body: JSON.stringify({ serviceId: service.id, params, token: token || undefined }),
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
          <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-base-line bg-black/40 text-xl">
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

      {buyerEnabled && service.params.length > 0 && (
        <div className="flex flex-col gap-2">
          {service.params.map((p) => (
            <label key={p.name} className="flex flex-col gap-1">
              <span className="label">{p.label}</span>
              {p.multiline ? (
                <textarea
                  rows={4}
                  className="resize-y rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm outline-none focus:border-base-blue"
                  placeholder={p.placeholder}
                  value={params[p.name] ?? ""}
                  onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}
                />
              ) : (
                <input
                  className="rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm outline-none focus:border-base-blue"
                  placeholder={p.placeholder}
                  value={params[p.name] ?? ""}
                  onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {buyerEnabled ? (
        <button className="btn-primary" onClick={buy} disabled={loading}>
          {loading ? "Processing…" : `Pay ${service.price} & call`}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-base-line bg-black/40 px-3 py-2">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500">GET</span>
            <code className="truncate font-mono text-[11px] text-sky-300">/api/x402/{service.id}</code>
          </div>
          {service.params.length > 0 && (
            <div className="text-[11px] text-gray-500">
              params: {service.params.map((p) => p.name).join(", ")}
            </div>
          )}
          <a href="/agents" className="btn-ghost">
            Call from your agent →
          </a>
        </div>
      )}

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
              {JSON.stringify(out.result?.data ?? out.result ?? out, null, 2)}
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

/** Group services by category, returning groups in CATEGORY_ORDER order.
 *  Any category not in CATEGORY_ORDER is appended at the end. */
function groupByCategory(services: ServiceMeta[]): Array<{ category: string; items: ServiceMeta[] }> {
  const map = new Map<string, ServiceMeta[]>();
  for (const s of services) {
    const existing = map.get(s.category);
    if (existing) {
      existing.push(s);
    } else {
      map.set(s.category, [s]);
    }
  }

  const ordered: Array<{ category: string; items: ServiceMeta[] }> = [];

  // Add known categories in preferred order
  for (const cat of CATEGORY_ORDER) {
    const items = map.get(cat);
    if (items) {
      ordered.push({ category: cat, items });
      map.delete(cat);
    }
  }

  // Append any remaining unknown categories
  for (const [category, items] of map) {
    ordered.push({ category, items });
  }

  return ordered;
}

export default function Marketplace({ services }: { services: ServiceMeta[] }) {
  const status = useStatus();
  const [token, setToken] = useState("");

  // Default to false until status loads so the Pay button can't be clicked early.
  const buyerEnabled = status !== null && (status.buyerEnabled ?? false);
  const tokenRequired = status?.buyTokenRequired ?? false;

  const [callsServed, setCallsServed] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/public-stats")
      .then((r) => r.json())
      .then((d) => setCallsServed(typeof d.callsServed === "number" ? d.callsServed : null))
      .catch(() => setCallsServed(null));
  }, []);

  const groups = groupByCategory(services);
  const flagship = services.find((s) => s.id === "ai-token-report");

  return (
    <div className="flex flex-col gap-10">
      {/* Hero */}
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-4">
          <span className="pill w-fit">⚡ x402 · Base mainnet · Builder Codes</span>

          <h1 className="max-w-2xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            A pay-per-call API marketplace where every payment is{" "}
            <span className="text-base-blue">attributed onchain</span>.
          </h1>

          <p className="max-w-xl text-sm leading-relaxed text-gray-400">
            Browse and call real APIs instantly — no signup, no API keys. Humans pay per use;
            autonomous agents settle USDC micro-payments over the{" "}
            <strong className="text-gray-200">x402 protocol</strong> on Base, with every transaction
            attributed onchain via{" "}
            <strong className="text-gray-200">ERC-8021 Builder Codes</strong>.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3">
            <a href="/agents" className="btn-primary">
              For agents &amp; API →
            </a>
            <a href="/dashboard" className="btn-ghost">
              Attribution →
            </a>
          </div>

          {/* Trust strip */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {TRUST_PILLS.map((p) => (
              <span key={p.label} className="pill">
                {p.label}
              </span>
            ))}
            <span className="pill border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {services.length} services live
              {callsServed && callsServed > 0 ? ` · ${callsServed.toLocaleString()} calls served` : ""}
            </span>
          </div>
        </div>

        <StatusBar status={status} />

        {!buyerEnabled && (
          <div className="card px-4 py-3 text-xs text-gray-400">
            🤖 These APIs are built for agents — they call the endpoints directly and pay per call in
            USDC. See{" "}
            <a className="text-sky-400 hover:underline" href="/agents">
              For agents
            </a>{" "}
            to integrate, or the{" "}
            <a className="text-sky-400 hover:underline" href="/dashboard">
              attribution dashboard
            </a>{" "}
            to decode any settlement on-chain.
          </div>
        )}

        {buyerEnabled && tokenRequired && (
          <label className="card flex flex-col gap-1 px-4 py-3">
            <span className="label">Access token (required to pay)</span>
            <input
              type="password"
              className="rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm outline-none focus:border-base-blue"
              placeholder="Enter the shared access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        )}
      </section>

      {/* Flagship — AI Token Report */}
      {flagship && (
        <section className="flex flex-col gap-3">
          <div className="label">Featured</div>
          <div className="card relative overflow-hidden border-base-blue/40 bg-gradient-to-br from-base-blue/15 via-black/20 to-black/10 p-5">
            <span className="pill mb-2 w-fit border-base-blue/40 bg-base-blue/10 text-sky-200">⭐ Flagship</span>
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-base-line bg-black/40 text-2xl">
                {flagship.icon}
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-bold">{flagship.name}</h2>
                <p className="mt-1 text-sm leading-relaxed text-gray-300">{flagship.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="pill">verdict: avoid → favorable</span>
                  <span className="pill">risks + positives</span>
                  <span className="font-mono font-bold text-emerald-300">{flagship.price}/call</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href="/agents" className="btn-primary !py-2 !text-xs">Use in your agent →</a>
                  <a href="https://t.me/Bazaar402_bot" target="_blank" rel="noreferrer" className="btn-ghost !py-2 !text-xs">
                    Try free in Telegram: /ai
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="flex flex-col gap-3">
        <div className="label">How it works</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { n: "1", t: "Discover", d: "Agents read the machine catalog at /.well-known/x402 or add the MCP server — every endpoint, price & schema." },
            { n: "2", t: "Call & pay", d: "Hit an endpoint; on HTTP 402 the agent pays a tiny USDC micro-payment over x402. Gasless for the payer." },
            { n: "3", t: "Get data", d: "Settlement is attributed onchain via Builder Codes; the agent gets the result instantly. No keys, no signup." },
          ].map((s) => (
            <div key={s.n} className="card p-4">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-base-blue/20 text-sm font-bold text-sky-300">
                {s.n}
              </div>
              <div className="mt-2 font-semibold">{s.t}</div>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <a className="pill hover:text-white" href="https://www.npmjs.com/package/x402-bazaar-mcp" target="_blank" rel="noreferrer">
            📦 npm: x402-bazaar-mcp
          </a>
          <span className="pill">🗂️ Official MCP Registry</span>
          <a className="pill hover:text-white" href="/openapi.json" target="_blank" rel="noreferrer">
            📄 OpenAPI
          </a>
          <a className="pill hover:text-white" href="/.well-known/x402" target="_blank" rel="noreferrer">
            🔎 Catalog
          </a>
        </div>
      </section>

      {/* Service groups */}
      {groups.map(({ category, items }) => (
        <section key={category} className="flex flex-col gap-3">
          <div className="label">{category}</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {items.map((s) => (
              <ServiceCard key={s.id} service={s} buyerEnabled={buyerEnabled} token={token} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
