import { SERVICES } from "@/lib/services";
import { MAX_CHILDREN } from "@/lib/fleet";
import FleetClient from "./FleetClient";

export const metadata = {
  title: "Fleet — spend limits for agent swarms — x402 Bazaar",
  description:
    "Give each agent its own credit token that spends from your prepaid balance under a daily cap, per-call limit and service allowlist you set. Pause or delete any of them; it stops on its next call.",
};

export default function FleetPage() {
  const serviceIds = SERVICES.filter((s) => !s.hidden && s.id !== "buy-credits")
    .map((s) => s.id)
    .sort();

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <span className="pill w-fit">🛰️ Fleet</span>
        <h1 className="text-3xl font-bold tracking-tight">One balance, many agents, hard limits.</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-gray-400">
          Issue a child token per agent. Each one spends from your prepaid credit balance — nothing new is
          bought — but only up to the daily cap you set (UTC day), optionally only below a per-call price and
          only on the services you list. Pause or delete a child and it is refused, uncharged, on its next call.
          Up to {MAX_CHILDREN} children per balance.
        </p>
        <p className="max-w-2xl text-xs leading-relaxed text-gray-500">
          Your parent token is kept in this page&apos;s memory only and is sent nowhere but this site&apos;s{" "}
          <code className="text-sky-300">/api/credits/fleet</code> endpoints, in a header. Reloading the page
          forgets it. No credit token yet?{" "}
          <a className="text-sky-400 hover:underline" href="/credits">
            Buy one
          </a>
          .
        </p>
      </section>

      <FleetClient serviceIds={serviceIds} />
    </div>
  );
}
