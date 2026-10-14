/**
 * /radar — cross-DEX spreads on a fixed Base watchlist, recently fired alerts,
 * and a live feed of recorded events. Every figure comes from /api/radar and
 * /api/events/live; nothing on this page is sample data.
 */

import RadarClient from "@/components/RadarClient";

export const metadata = {
  title: "Radar — x402 Bazaar",
  description:
    "Cross-DEX price spreads on Base for a fixed watchlist, recently fired price and liquidity alerts, and a live feed of paid calls — all from real measurements.",
};

export default function RadarPage() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">📡 Radar</span>
        <h1 className="text-3xl font-bold tracking-tight">Base market radar</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-gray-400">
          Cross-DEX spreads for a fixed watchlist of liquid Base tokens, computed with the same logic as the paid{" "}
          <code>dex-spread</code> service and refreshed at most once a minute. Below them: alerts that actually fired
          and a live feed of paid calls by outside agents. Nothing here is simulated — if a token could not be read it
          says &ldquo;no data&rdquo;, and if nothing happened the feed says so. JSON at{" "}
          <a className="text-sky-400 hover:underline" href="/api/radar">/api/radar</a>, stream at{" "}
          <a className="text-sky-400 hover:underline" href="/api/events/live">/api/events/live</a>.
        </p>
      </section>
      <RadarClient />
    </div>
  );
}
