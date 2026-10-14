/**
 * Public leaderboard: what outside agents actually paid for, from the ledger the
 * x402 path writes at settlement (src/lib/keepalive-economics.ts). Our own
 * buyer's purchases — keepalive and indexing — never enter it. Small numbers
 * are shown as they are. JSON at /api/leaderboard.
 */

import { externalLeaderboard } from "@/lib/keepalive-economics";
import { readHealth } from "@/lib/health";
import { SERVICES } from "@/lib/services";

export const metadata = {
  title: "Leaderboard — x402 Bazaar",
  description: "Which x402 Bazaar services outside agents actually pay for, counted at settlement with our own purchases excluded.",
};

export const revalidate = 300;

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export default async function LeaderboardPage() {
  const [lb, health] = await Promise.all([externalLeaderboard(), readHealth(7).catch(() => null)]);
  const byId = new Map(SERVICES.map((s) => [s.id, s]));
  const success = new Map((health?.services ?? []).map((h) => [h.service, h.successPct]));
  const rows = lb.services.slice(0, 25);
  const listedCount = SERVICES.filter((s) => !s.hidden).length;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🏆 Leaderboard</span>
        <h1 className="text-3xl font-bold tracking-tight">What outside agents actually pay for</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Every number here is a paid x402 call whose signer was <em>not</em> us, counted when it settled. Our own
          keepalive and indexing purchases are excluded, and so is any payer we can&apos;t read. No revenue figures,
          no wallet addresses. Refreshed every 5 minutes; JSON at{" "}
          <a className="text-sky-400 hover:underline" href="/api/leaderboard">/api/leaderboard</a>.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <div className="label">Outside paid calls</div>
          <div className="mt-1 font-mono text-2xl font-bold">{lb.externalCalls}</div>
          <div className="mt-1 text-xs text-gray-500">since {day(lb.since)}</div>
        </div>
        <div className="card p-4">
          <div className="label">Distinct outside buyers</div>
          <div className="mt-1 font-mono text-2xl font-bold">{lb.distinctPayers}</div>
          <div className="mt-1 text-xs text-gray-500">since {day(lb.since)}</div>
        </div>
        <div className="card p-4">
          <div className="label">Services bought</div>
          <div className="mt-1 font-mono text-2xl font-bold">
            {lb.services.length}
            <span className="text-sm text-gray-500"> / {listedCount}</span>
          </div>
        </div>
        <div className="card p-4">
          <div className="label">Ranked since</div>
          <div className="mt-1 font-mono text-2xl font-bold">{day(lb.since)}</div>
        </div>
      </section>

      <section className="card overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-gray-400">
            No outside purchases yet since counting started ({day(lb.since)}). This table fills in as agents buy.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3 text-right">Outside paid calls</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">Success, 7d</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const svc = byId.get(r.id);
                const pct = success.get(r.id) ?? null;
                return (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="px-4 py-3 font-mono text-gray-500">{i + 1}</td>
                    <td className="px-4 py-3">
                      <span className="mr-1.5">{svc?.icon ?? "•"}</span>
                      <span className="font-medium">{svc?.name ?? r.id}</span>
                      {!svc && <span className="ml-2 text-xs text-gray-500">(no longer listed)</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{r.calls}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">{svc?.price ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">{pct === null ? "—" : `${pct}%`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-gray-500">
        Counting started {day(lb.since)}. Calls paid from prepaid credits are not counted here yet.
      </p>
    </div>
  );
}
