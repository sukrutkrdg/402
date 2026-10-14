"use client";

/**
 * Client side of /radar: reads /api/radar once a minute (the server caches the
 * snapshot for 60s, so polling faster would only re-read the same numbers) and
 * holds an EventSource on /api/events/live while the tab is visible. The server
 * closes each stream after 55s and EventSource reconnects on its own.
 *
 * Scout scans are shown as "our scan at <time> computed <verdict/flags>" with a
 * re-check link — never as a statement that a token is a scam.
 */

import { useEffect, useState } from "react";
import type { RadarSnapshot, RadarRow } from "@/lib/radar";
import type { AlertEvent, LiveEvent, PublicScan, ScanEvent } from "@/lib/live-events";

interface RadarResponse {
  spreads: RadarSnapshot | null;
  alerts: AlertEvent[];
  scans: PublicScan[];
  method: { spreads: string; alerts: string; scanFlags: string };
}

const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;
const price = (n: number) => (n >= 1 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${n.toPrecision(4)}`);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n}%`);

const VERDICT: Record<string, { label: string; cls: string }> = {
  tight: { label: "tight", cls: "text-emerald-400" },
  arb_window: { label: "arb window", cls: "text-amber-300" },
  wide: { label: "wide", cls: "text-rose-400" },
  single_venue: { label: "one liquid venue", cls: "text-gray-400" },
};

function SpreadRow({ r }: { r: RadarRow }) {
  if (r.status === "no_data") {
    return (
      <tr className="border-t border-white/5">
        <td className="px-4 py-3 font-medium">{r.symbol}</td>
        <td className="px-4 py-3 text-right text-gray-500" colSpan={3}>
          no data
        </td>
        <td className="px-4 py-3 text-xs text-gray-500">{r.reason ?? "could not be read"}</td>
      </tr>
    );
  }
  const v = r.verdict ? VERDICT[r.verdict] : null;
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="px-4 py-3 font-medium">
        <a className="hover:underline" href={`https://basescan.org/token/${r.address}`} target="_blank" rel="noreferrer">
          {r.symbol}
        </a>
      </td>
      <td className="px-4 py-3 text-right font-mono">{r.spreadBps === null ? <span className="text-gray-500">—</span> : `${r.spreadBps} bps`}</td>
      <td className={`px-4 py-3 text-right text-xs ${v?.cls ?? ""}`}>{v?.label ?? "—"}</td>
      <td className="px-4 py-3 text-right font-mono text-xs text-gray-400">
        {r.liquidVenues ?? "—"} / {r.totalVenues ?? "—"}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400">
        {r.venues.length === 0
          ? "no data"
          : r.venues.map((p, i) => (
              <span key={i} className="mr-3 inline-block whitespace-nowrap">
                {p.dex ?? "?"}
                {p.quote ? `/${p.quote}` : ""} {price(p.priceUsd)} · liq {usd(p.liquidityUsd)}
              </span>
            ))}
      </td>
    </tr>
  );
}

function AlertLine({ e }: { e: AlertEvent }) {
  const what =
    e.type === "rug_warning"
      ? `liquidity ${pct(e.changePct)} from the subscriber's baseline`
      : `price crossed ${e.direction ?? ""} a subscriber's threshold (${pct(e.changePct)} since set)`;
  return (
    <span>
      <span className={e.type === "rug_warning" ? "text-rose-300" : "text-amber-300"}>
        {e.type === "rug_warning" ? "Liquidity warning" : "Price alert"}
      </span>{" "}
      <a className="font-mono hover:underline" href={`https://basescan.org/token/${e.token}`} target="_blank" rel="noreferrer">
        {short(e.token)}
      </a>{" "}
      — {what}.{" "}
      <a className="text-sky-400 hover:underline" href={`/api/x402/token-risk?address=${e.token}&free=1`}>
        check it
      </a>
    </span>
  );
}

const LEVEL_CLS: Record<string, string> = {
  high: "text-rose-400",
  medium: "text-amber-300",
  low: "text-emerald-400",
  unknown: "text-gray-400",
};

/** What the scan computed, in words — "flagged" is about our check, not a claim about the token. */
function scanSummary(s: Pick<ScanEvent, "verdict" | "level" | "score">): { text: string; cls: string } {
  if (s.verdict === "sell_side_flags") return { text: "sell-side flags", cls: "text-rose-400" };
  if (s.verdict === "not_scored") return { text: "not scored", cls: "text-gray-400" };
  const lvl = s.level ?? "unknown";
  return { text: `risk ${lvl}${s.score === null ? "" : ` · ${s.score}/100`}`, cls: LEVEL_CLS[lvl] ?? "text-gray-400" };
}

const scanFlags = (s: Pick<ScanEvent, "sellSideFlags" | "riskSignals">) => [...s.sellSideFlags, ...s.riskSignals];

function ScanLine({ e }: { e: ScanEvent }) {
  const sum = scanSummary(e);
  const flags = scanFlags(e);
  return (
    <span>
      <span className="text-sky-300">Scout scan</span>{" "}
      <a className="font-mono hover:underline" href={`https://basescan.org/token/${e.token}`} target="_blank" rel="noreferrer">
        {e.symbol ? `${e.symbol} ` : ""}
        {short(e.token)}
      </a>{" "}
      — our scan computed <span className={sum.cls}>{sum.text}</span>
      {flags.length ? `: ${flags.slice(0, 3).join(", ")}` : ""}
      {e.degraded ? " (partial check)" : ""}.{" "}
      <a className="text-sky-400 hover:underline" href={`/api/x402/rug-score?address=${e.token}&free=1`}>
        re-check
      </a>
    </span>
  );
}

function ScanRow({ s }: { s: PublicScan }) {
  const sum = scanSummary(s);
  const flags = scanFlags(s);
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-500" title={s.at}>
        {dateTime(s.at)}
      </td>
      <td className="px-4 py-3">
        <a className="font-mono text-xs hover:underline" href={`https://basescan.org/token/${s.token}`} target="_blank" rel="noreferrer">
          {s.symbol ? <span className="mr-1 font-sans text-sm">{s.symbol}</span> : null}
          {short(s.token)}
        </a>
      </td>
      <td className={`whitespace-nowrap px-4 py-3 text-xs ${sum.cls}`}>
        {sum.text}
        {s.degraded ? <span className="ml-1 text-amber-300" title="Not every check answered; no low risk is certified">· partial</span> : null}
      </td>
      <td className="px-4 py-3 text-xs text-gray-300">{flags.length ? flags.join(" · ") : <span className="text-gray-500">none raised</span>}</td>
      <td className="px-4 py-3 text-xs text-gray-400">
        {s.sources.join(", ") || "—"}
        {s.sourcesMissing.length ? <span className="block text-amber-300/80">no answer: {s.sourcesMissing.join(", ")}</span> : null}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs">
        <a className="text-sky-400 hover:underline" href={s.recheck}>
          re-check
        </a>
        {s.attestationUrl ? (
          <a className="ml-2 text-gray-400 hover:underline" href={s.attestationUrl} target="_blank" rel="noreferrer">
            EAS
          </a>
        ) : null}
      </td>
    </tr>
  );
}

function FeedLine({ e }: { e: LiveEvent }) {
  if (e.kind === "paid_call") {
    return (
      <span>
        <span className="text-emerald-400">Paid call</span> <code>{e.service}</code> · ${e.priceUsd}
      </span>
    );
  }
  if (e.kind === "scan") return <ScanLine e={e} />;
  return <AlertLine e={e} />;
}

function LivePanel() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [state, setState] = useState<"connecting" | "open" | "reconnecting" | "paused">("connecting");
  const [recorded, setRecorded] = useState<number | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    const add = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as LiveEvent;
        setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [e, ...prev].slice(0, 50)));
      } catch {
        /* ignore malformed */
      }
    };
    const open = () => {
      if (es) return;
      setState("connecting");
      es = new EventSource("/api/events/live");
      es.onopen = () => setState("open");
      es.onerror = () => setState("reconnecting"); // EventSource retries by itself
      es.addEventListener("status", (ev) => {
        try {
          setRecorded((JSON.parse((ev as MessageEvent).data) as { recordedEvents: number }).recordedEvents);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("paid_call", add as EventListener);
      es.addEventListener("alert", add as EventListener);
      es.addEventListener("scan", add as EventListener);
    };
    const shut = () => {
      es?.close();
      es = null;
      setState("paused");
    };
    const onVis = () => (document.visibilityState === "visible" ? open() : shut());
    open();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      es?.close();
    };
  }, []);

  const dot = state === "open" ? "bg-emerald-400" : state === "paused" ? "bg-gray-500" : "bg-amber-400";
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <h2 className="text-lg font-semibold">Live</h2>
        <span className="text-xs text-gray-500">
          {state === "open" ? "connected" : state === "paused" ? "paused while tab hidden" : state}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-gray-400">
          {recorded === 0
            ? "Nothing recorded yet. This feed shows only real events — paid calls by outside agents, alerts that fired and our scout's scans — so it stays empty until one happens."
            : "No events since you opened this page. Only real paid calls, alert firings and scout scans appear here."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className="w-20 shrink-0 font-mono text-xs text-gray-500" title={e.at}>
                {time(e.at)}
              </span>
              <FeedLine e={e} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-gray-500">
        Paid calls show service, price and time only — never the payer. Our own keepalive and indexing purchases are
        excluded. Recent events replay with their original time when you connect.
      </p>
    </section>
  );
}

export default function RadarClient() {
  const [data, setData] = useState<RadarResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/radar");
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as RadarResponse;
        if (alive) {
          setData(j);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const spreads = data?.spreads ?? null;
  return (
    <>
      <section className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
          <h2 className="text-lg font-semibold">Cross-DEX spreads on Base</h2>
          <span className="text-xs text-gray-500">
            {spreads ? `as of ${time(spreads.asOf)} · venues ≥ $${spreads.minLiquidityUsd.toLocaleString("en-US")} liquidity` : ""}
          </span>
        </div>
        {!data && !failed && <p className="p-4 text-sm text-gray-400">Loading…</p>}
        {(failed || (data && !spreads)) && (
          <p className="p-4 text-sm text-gray-400">No data — the spread snapshot could not be read right now.</p>
        )}
        {spreads && (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">Token</th>
                <th className="px-4 py-2 text-right">Spread</th>
                <th className="px-4 py-2 text-right">Verdict</th>
                <th className="px-4 py-2 text-right">Liquid / all venues</th>
                <th className="px-4 py-2">Top venues (price · liquidity)</th>
              </tr>
            </thead>
            <tbody>
              {spreads.rows.map((r) => (
                <SpreadRow key={r.address} r={r} />
              ))}
            </tbody>
          </table>
        )}
        {data && <p className="px-4 py-3 text-xs text-gray-500">{data.method.spreads} DexScreener snapshots — not a trade quote, not financial advice.</p>}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-lg font-semibold">Recently fired alerts</h2>
        {!data ? (
          <p className="text-sm text-gray-400">{failed ? "No data — could not be read right now." : "Loading…"}</p>
        ) : data.alerts.length === 0 ? (
          <p className="text-sm text-gray-400">
            No alerts have fired recently. Customers&apos; price alerts and liquidity monitors are checked every 10
            minutes; a firing shows up here when one crosses its threshold.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {data.alerts.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-28 shrink-0 font-mono text-xs text-gray-500" title={e.at}>
                  {dateTime(e.at)}
                </span>
                <AlertLine e={e} />
              </li>
            ))}
          </ul>
        )}
        {data && <p className="mt-3 text-xs text-gray-500">{data.method.alerts}</p>}
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="px-4 pt-4">
          <h2 className="text-lg font-semibold">Latest scans</h2>
        </div>
        {!data ? (
          <p className="p-4 text-sm text-gray-400">{failed ? "No data — could not be read right now." : "Loading…"}</p>
        ) : data.scans.length === 0 ? (
          <p className="p-4 text-sm text-gray-400">
            No scans recorded yet. Our scout scans newly listed Base tokens every 4 hours; each scan appears here as it
            was computed.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">Scanned</th>
                <th className="px-4 py-2">Token</th>
                <th className="px-4 py-2">Our scan computed</th>
                <th className="px-4 py-2">Flags at scan time</th>
                <th className="px-4 py-2">Sources</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.scans.map((s) => (
                <ScanRow key={s.id} s={s} />
              ))}
            </tbody>
          </table>
        )}
        {data && <p className="px-4 py-3 text-xs text-gray-500">{data.method.scanFlags}</p>}
      </section>

      <LivePanel />
    </>
  );
}
