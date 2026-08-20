import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { priceCents } from "@/lib/price";
import { SERVICES } from "@/lib/services";

/**
 * A spend cap that makes an endpoint unbuyable is not a cap, it is a deletion.
 *
 * The keepalive cron bounded each run at 60 cents with
 * `spent + cents > MAX_SPEND_CENTS` → defer. Both $0.75 reports — deep-dd and
 * b20-dossier, the most expensive things we sell — cost more than the entire
 * per-run budget, so that test was true for them at `spent = 0`. They were
 * deferred on every run, forever. Nothing surfaced it: "deferred-next-run" is
 * the same word the cron uses for a service that simply lost its turn today, so
 * the log looked normal every single day while the two listings the index would
 * miss most drifted toward eviction with keepalive never once having tried.
 *
 * Letting the first purchase of a run exceed the cap keeps the guarantee that
 * matters (a run cannot run away with the wallet: worst case is cap + one
 * price) while removing the one it never meant to make.
 */
const src = readFileSync(new URL("../src/app/api/cron/index-all/route.ts", import.meta.url), "utf8");
const capOf = (name: string) => Number(src.match(new RegExp(`const ${name} = (\\d+)`))?.[1]);

describe("the per-run spend cap", () => {
  it("exempts the first purchase, so no single price can be permanently deferred", () => {
    expect(src).toMatch(/const overCap = spent \+ cents > MAX_SPEND_CENTS && spent > 0;/);
    expect(src, "the bare comparison is what excluded them").not.toMatch(/\|\| spent \+ cents > MAX_SPEND_CENTS\)/);
  });

  it("still bounds a run: nothing is attempted once something has been spent and the cap is reached", () => {
    // The exemption is one purchase deep, not a hole.
    const guard = src.slice(src.indexOf("const overCap"), src.indexOf("continue;", src.indexOf("const overCap")));
    expect(guard).toMatch(/attempts >= MAX_PER_RUN \|\| overCap/);
  });

  it("names the services that needed it, so the reason cannot be edited away by accident", () => {
    const cap = capOf("MAX_SPEND_CENTS");
    expect(Number.isFinite(cap)).toBe(true);
    const overCap = SERVICES.filter((s) => !s.hidden && s.id !== "buy-credits" && priceCents(s.price) > cap).map((s) => s.id);
    // If this ever empties out the guard is still correct, but the day someone
    // adds a pricier endpoint it starts mattering again — which is the point.
    expect(overCap, "our $0.75 reports are the case this exists for").toEqual(
      expect.arrayContaining(["deep-dd", "b20-dossier"]),
    );
    for (const id of overCap) {
      const svc = SERVICES.find((s) => s.id === id)!;
      expect(priceCents(svc.price), `${id} alone exceeds the run cap`).toBeGreaterThan(cap);
    }
  });

  it("keeps the count cap untouched — that one was never the problem", () => {
    expect(capOf("MAX_PER_RUN")).toBeGreaterThan(0);
  });
});
