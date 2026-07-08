"use client";

import { useEffect, useState } from "react";
import type { Connector } from "wagmi";
import StatusBar, { useStatus } from "./StatusBar";
import { useX402Pay, PICK_WALLET } from "@/lib/x402-wallet";
import OnrampButton from "./OnrampButton";

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
const CATEGORY_ORDER = ["AI", "Onchain", "Markets", "Data", "Utility", "Fun", "Demo"];

// The AI synthesis suite — the differentiated moat, featured up top.
const AI_FLAGSHIP_IDS = [
  "ai-token-report",
  "ai-wallet-report",
  "ai-market-brief",
  "ai-wallet-security",
  "ai-contract-risk",
  "ai-tx-explain",
];

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
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletData, setWalletData] = useState<unknown>(null);
  const { pay, picker, setPicker, step } = useX402Pay();

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

  // Pay for this service from the VISITOR's own browser wallet over x402.
  async function payWithWallet(chosen?: Connector) {
    const missing = service.params.find((p) => p.required && !(params[p.name] ?? "").trim());
    if (missing) {
      setError(`Enter ${missing.label} first.`);
      return;
    }
    setWalletBusy(true);
    setError(null);
    setOut(null);
    setWalletData(null);
    try {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([, v]) => (v ?? "").trim())),
      ).toString();
      const r = await pay(`/api/x402/${service.id}${qs ? `?${qs}` : ""}`, chosen);
      if (r === PICK_WALLET) return; // picker is showing; user will choose
      const text = await r.text();
      if (!r.ok) {
        let msg = text.slice(0, 200) || `server ${r.status}`;
        try {
          msg = (JSON.parse(text).error as string) || msg;
        } catch {
          /* keep raw */
        }
        throw new Error(
          r.status >= 400 && r.status < 500 && r.status !== 402
            ? `Check failed (${r.status}): ${msg} — you were NOT charged.`
            : `Payment failed (${r.status}): ${msg}`,
        );
      }
      const json = JSON.parse(text);
      setWalletData(json.data ?? json);
    } catch (e) {
      const m = e instanceof Error ? e.message : "Payment failed";
      const needsUsdc = /insufficient|balance|settle|402/i.test(m);
      setError(`${m}${needsUsdc ? " — you may be out of USDC on Base. Add some below, then retry." : ""}`);
    } finally {
      setWalletBusy(false);
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

      {service.params.length > 0 && (
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

      {/* Pay with the visitor's OWN browser wallet (Base App / Farcaster host,
          or MetaMask / Coinbase in a plain browser) over x402. */}
      <button className="btn-primary" onClick={() => payWithWallet()} disabled={walletBusy || loading}>
        {walletBusy ? "Paying…" : `Pay ${service.price} with wallet`}
      </button>

      {picker && (
        <div className="flex flex-col gap-2 rounded-lg border border-base-blue/30 bg-base-blue/10 p-3">
          <span className="text-[11px] text-sky-200">Choose a wallet:</span>
          <div className="flex flex-wrap gap-2">
            {picker.map((c) => (
              <button key={c.uid} onClick={() => payWithWallet(c)} className="btn-ghost !px-3 !py-1.5 text-xs">
                {c.name}
              </button>
            ))}
            <button onClick={() => setPicker(null)} className="btn-ghost !px-3 !py-1.5 text-xs opacity-60">
              Cancel
            </button>
          </div>
        </div>
      )}
      {walletBusy && step && (
        <div className="rounded-lg border border-base-blue/30 bg-base-blue/10 px-3 py-2 text-[11px] text-sky-200">{step}</div>
      )}

      {buyerEnabled && (
        <button className="btn-ghost !py-2 text-xs" onClick={buy} disabled={loading || walletBusy}>
          {loading ? "Processing…" : "Demo pay (server wallet)"}
        </button>
      )}

      <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-base-line bg-black/40 px-3 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500">GET</span>
        <code className="truncate font-mono text-[11px] text-sky-300">/api/x402/{service.id}</code>
        <a href="/agents" className="ml-auto shrink-0 text-[11px] text-sky-400 hover:underline">
          agent →
        </a>
      </div>

      {walletData !== null && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="label mb-1 text-emerald-300">✓ Paid · response</div>
          <pre className="max-h-48 overflow-auto rounded-lg bg-black/50 p-3 text-[11px] leading-relaxed text-sky-200">
            {JSON.stringify(walletData, null, 2)}
          </pre>
        </div>
      )}

      {error && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
          {/insufficient|balance|settle|402/i.test(error) && <OnrampButton />}
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
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState<string | null>(null);

  // Default to false until status loads so the Pay button can't be clicked early.
  const buyerEnabled = status !== null && (status.buyerEnabled ?? false);
  const tokenRequired = status?.buyTokenRequired ?? false;

  const [callsServed, setCallsServed] = useState<number | null>(null);
  const [paidServed, setPaidServed] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/public-stats")
      .then((r) => r.json())
      .then((d) => {
        setCallsServed(typeof d.callsServed === "number" ? d.callsServed : null);
        setPaidServed(typeof d.paidServed === "number" ? d.paidServed : null);
      })
      .catch(() => setCallsServed(null));
  }, []);

  const q = search.trim().toLowerCase();
  const visible = services.filter((s) => {
    if (cat && s.category !== cat) return false;
    if (q && !`${s.name} ${s.tagline} ${s.description} ${s.category} ${s.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const groups = groupByCategory(visible);
  const cats = CATEGORY_ORDER.filter((c) => services.some((s) => s.category === c));
  const flagship = services.find((s) => s.id === "ai-token-report");
  // Retention services — set once, get pinged later (recurring value).
  const alertSuite = ["rug-monitor", "price-alert", "token-unlock"]
    .map((id) => services.find((s) => s.id === id))
    .filter((s): s is ServiceMeta => Boolean(s));
  const aiSuite = AI_FLAGSHIP_IDS.map((id) => services.find((s) => s.id === id)).filter(
    (s): s is ServiceMeta => Boolean(s),
  );

  return (
    <div className="flex flex-col gap-10">
      {/* B20 launch banner */}
      <a
        href="/app"
        className="flex flex-col gap-2 rounded-2xl border border-amber-500/40 bg-gradient-to-r from-amber-500/15 to-base-blue/10 p-4 transition hover:border-amber-400/60 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-amber-200">
            🆕 B20 activates tonight on Base — first B20 safety check, ready to go
          </span>
          <span className="max-w-2xl text-xs leading-relaxed text-gray-300">
            Base&apos;s native token standard lets issuers{" "}
            <strong className="text-amber-200">freeze</strong> and even{" "}
            <strong className="text-amber-200">seize</strong> your balance at the protocol level —
            risks no ERC-20 tool checks. We built the first B20 safety check.
          </span>
        </div>
        <span className="btn-primary shrink-0 !py-2 text-sm">Check B20 safety →</span>
      </a>

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
            <a href="/app" className="btn-primary">
              🛡️ Check a token →
            </a>
            <a href="/agents" className="btn-ghost">
              For agents &amp; API →
            </a>
            <a href="/dashboard" className="btn-ghost">
              Attribution →
            </a>
            <OnrampButton className="!inline-flex" />
          </div>

          {/* Trust strip */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {TRUST_PILLS.map((p) => (
              <span key={p.label} className="pill">
                {p.label}
              </span>
            ))}
            <span className="pill border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              {services.length} services live
              {callsServed && callsServed > 0 ? ` · ${callsServed.toLocaleString()} calls served` : ""}
            </span>
            {paidServed && paidServed > 0 ? (
              <span className="pill border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                💸 {paidServed.toLocaleString()} paid by agents
              </span>
            ) : null}
          </div>

          {/* Social proof — AIXBT */}
          <a
            href="https://x.com/aixbt_agent/status/2070986190191559016"
            target="_blank"
            rel="noreferrer"
            className="group mt-1 flex max-w-xl items-start gap-3 rounded-xl border border-base-line/70 bg-white/[0.03] px-4 py-3 transition hover:border-base-blue/50 hover:bg-white/[0.05]"
          >
            <span className="mt-0.5 shrink-0 text-base-blue">❝</span>
            <span className="text-sm leading-relaxed text-gray-300">
              Token safety checks before agent execution is{" "}
              <strong className="text-gray-100">necessary infrastructure</strong>. The honeypot/rug/tax
              layer could filter a lot of noise before it hits feeds.
              <span className="mt-1 block text-xs text-gray-500 group-hover:text-base-blue">
                — @aixbt_agent on x402 Bazaar ↗
              </span>
            </span>
          </a>
        </div>

        <StatusBar status={status} />

        {!buyerEnabled && (
          <div className="card px-4 py-3 text-xs text-gray-400">
            🤖 These APIs are built for agents — they call the endpoints directly and pay per call in
            USDC. <strong className="text-gray-200">First 3 calls/day per IP are free</strong>{" "}
            (non-AI) — no wallet needed to try. See{" "}
            <a className="text-sky-400 hover:underline" href="/agents">
              For agents
            </a>{" "}
            to integrate, or the{" "}
            <a className="text-sky-400 hover:underline" href="/dashboard">
              dashboard
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

      {/* AI intelligence suite — the moat */}
      {aiSuite.length > 1 && (
        <section className="flex flex-col gap-3">
          <div className="label">AI intelligence — synthesis you can&apos;t get from a raw feed</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {aiSuite.map((s) => (
              <div key={s.id} className="card p-3">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-xl">
                    {s.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{s.name}</div>
                    <div className="font-mono text-xs text-emerald-300">{s.price}</div>
                  </div>
                </div>
                <p className="mt-1 text-xs leading-snug text-gray-400">{s.tagline}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Retention — monitoring & alerts (set once, get pinged later) */}
      {alertSuite.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="label">🔔 Set &amp; forget — monitoring &amp; alerts (recurring value)</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {alertSuite.map((s) => (
              <div key={s.id} className="card p-3">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-xl">
                    {s.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{s.name}</div>
                    <div className="font-mono text-xs text-emerald-300">{s.price}</div>
                  </div>
                </div>
                <p className="mt-1 text-xs leading-snug text-gray-400">{s.tagline}</p>
              </div>
            ))}
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
          <a className="pill hover:text-white" href="https://github.com/sukrutkrdg/x402-bazaar-mcp" target="_blank" rel="noreferrer">
            🗂️ MCP server (Registry)
          </a>
          <a className="pill hover:text-white" href="/openapi.json" target="_blank" rel="noreferrer">
            📄 OpenAPI
          </a>
          <a className="pill hover:text-white" href="/.well-known/x402" target="_blank" rel="noreferrer">
            🔎 Catalog
          </a>
        </div>
      </section>

      {/* Search + service groups */}
      <section className="flex flex-col gap-2">
        <div className="label">Browse {services.length} services</div>
        <input
          type="search"
          className="rounded-xl border border-base-line bg-black/40 px-4 py-2.5 text-sm outline-none focus:border-base-blue"
          placeholder="Search services — e.g. honeypot, wallet, sanctions, price…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCat(null)}
            className={`pill ${cat === null ? "border-base-blue/50 bg-base-blue/15 text-sky-200" : "hover:text-white"}`}
          >
            All
          </button>
          {cats.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c === cat ? null : c)}
              className={`pill ${c === cat ? "border-base-blue/50 bg-base-blue/15 text-sky-200" : "hover:text-white"}`}
            >
              {c}
            </button>
          ))}
        </div>
        {q && (
          <p className="text-[11px] text-gray-500">
            {visible.length} match{visible.length === 1 ? "" : "es"} for “{search}”
            {visible.length === 0 ? " — try a different term." : ""}
          </p>
        )}
      </section>

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
