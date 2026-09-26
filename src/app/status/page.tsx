/**
 * Public service status: how each endpoint actually behaved over the last week,
 * measured on real calls (src/lib/health.ts). Agents and directories judge a
 * seller on reliability; this is ours, unedited. JSON at /api/status.
 */

import { readHealth } from "@/lib/health";
import { SERVICES } from "@/lib/services";

export const metadata = {
  title: "Status — x402 Bazaar",
  description: "Live reliability of every x402 Bazaar endpoint over the last 7 days: calls, success rate and latency, measured on real calls.",
};

export const revalidate = 300;

const tone = (pct: number | null) =>
  pct === null ? "text-gray-500" : pct >= 99 ? "text-emerald-300" : pct >= 95 ? "text-amber-300" : "text-rose-300";

export default async function StatusPage() {
  const h = await readHealth(7);
  const byId = new Map(SERVICES.filter((s) => !s.hidden).map((s) => [s.id, s]));
  const rows = h.services.filter((s) => byId.has(s.service)).sort((a, b) => b.calls - a.calls);
  const ok = rows.reduce((s, x) => s + x.ok, 0);
  const fail = rows.reduce((s, x) => s + x.fail, 0);
  const overall = ok + fail ? +((ok / (ok + fail)) * 100).toFixed(1) : null;
  const quiet = [...byId.keys()].filter((id) => !rows.some((r) => r.service === id));
  const failing = rows.filter((r) => r.lastDay.fail > 0 && r.successPct !== null && r.successPct < 95);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">📈 Status</span>
        <h1 className="text-3xl font-bold tracking-tight">How every endpoint behaved this week</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Measured on every real call, not synthetic pings. Success counts our own failures only — a request refused for bad
          input is the caller&apos;s. Failed calls are never charged. Refreshed every 5 minutes; machine-readable at{" "}
          <a className="text-sky-400 hover:underline" href="/api/status">/api/status</a>.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <div className="label">Success, 7 days</div>
          <div className={`mt-1 font-mono text-2xl font-bold ${tone(overall)}`}>{overall === null ? "—" : `${overall}%`}</div>
        </div>
        <div className="card p-4">
          <div className="label">Calls, 7 days</div>
          <div className="mt-1 font-mono text-2xl font-bold">{rows.reduce((s, x) => s + x.calls, 0)}</div>
        </div>
        <div className="card p-4">
          <div className="label">Endpoints called</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {rows.length}
            <span className="text-sm text-gray-500"> / {byId.size}</span>
          </div>
        </div>
        <div className="card p-4">
          <div className="label">Degraded now</div>
          <div className={`mt-1 font-mono text-2xl font-bold ${failing.length ? "text-rose-300" : "text-emerald-300"}`}>{failing.length}</div>
          <div className="text-[10px] text-gray-500">under 95% with failures in the last day</div>
        </div>
      </section>

      <section className="overflow-x-auto rounded-2xl border border-base-line">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Endpoint</th>
              <th className="px-3 py-2 text-right">Calls</th>
              <th className="px-3 py-2 text-right">Success</th>
              <th className="px-3 py-2 text-right">Our failures</th>
              <th className="px-3 py-2 text-right">Refused input</th>
              <th className="px-3 py-2 text-right">Median</th>
              <th className="px-3 py-2 text-right">p90</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.service}>
                <td className="border-t border-base-line px-3 py-2">
                  {byId.get(r.service)?.name ?? r.service}
                  <div className="font-mono text-[10px] text-gray-500">{r.service}</div>
                </td>
                <td className="border-t border-base-line px-3 py-2 text-right font-mono">{r.calls}</td>
                <td className={`border-t border-base-line px-3 py-2 text-right font-mono ${tone(r.successPct)}`}>
                  {r.successPct === null ? "—" : `${r.successPct}%`}
                </td>
                <td className="border-t border-base-line px-3 py-2 text-right font-mono">{r.fail}</td>
                <td className="border-t border-base-line px-3 py-2 text-right font-mono text-gray-500">{r.input}</td>
                <td className="border-t border-base-line px-3 py-2 text-right font-mono">{r.p50 ?? "—"}</td>
                <td className="border-t border-base-line px-3 py-2 text-right font-mono">{r.p90 ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {quiet.length > 0 && (
        <p className="text-xs text-gray-500">
          Not called this week ({quiet.length}): {quiet.sort().join(", ")}.
        </p>
      )}
    </div>
  );
}
