import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { exampleInputFor } from "../src/lib/discovery-examples";
import { priceCents } from "../src/lib/price";
import { INDEX_FRESH_SECONDS, indexFreshKey } from "../src/lib/index-freshness";

/**
 * The index-refresh cron is the only scheduled thing in this project that spends
 * money, so what is worth locking is the ceiling and the input — not the
 * behaviour, which is one paid call in a loop.
 *
 * Its previous parameter map handed the USDC contract to every address-shaped
 * field. Against the B20 endpoints that produces "not a B20 token", an error
 * settles nothing, and a call that settles nothing indexes nothing — so the run
 * would have burned the wallet on calls that bought exactly zero listings.
 */
const cron = readFileSync(new URL("../src/app/api/cron/index-all/route.ts", import.meta.url), "utf8");
const paid = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  crons: { path: string; schedule: string }[];
};

function services(): { id: string; category: string; price: string; params: { name: string; label: string; placeholder: string; required?: boolean }[] }[] {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  const out: ReturnType<typeof services> = [];
  for (const chunk of src.split(/\r?\n {2}\{\r?\n/).slice(1)) {
    const body = chunk.split(/\r?\n {2}\},?\r?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    const category = body.match(/^\s*category:\s*"([^"]+)"/m)?.[1];
    const price = body.match(/^\s*price:\s*"([^"]+)"/m)?.[1];
    if (!id || !category || !price || /^\s*\/\//.test(body)) continue;
    const params = [...body.matchAll(/\{[^{}]*\bname:\s*"(\w+)"[^{}]*\}/g)].map((m) => ({
      name: m[1],
      label: m[0].match(/label:\s*"([^"]*)"/)?.[1] ?? "",
      placeholder: m[0].match(/placeholder:\s*"([^"]*)"/)?.[1] ?? "",
      required: /required:\s*true/.test(m[0]),
    }));
    out.push({ id, category, price, params });
  }
  return out;
}

describe("index refresh spends inside a ceiling", () => {
  it("caps both the call count and the money per run", () => {
    const perRun = Number(cron.match(/MAX_PER_RUN = (\d+)/)?.[1]);
    const capCents = Number(cron.match(/MAX_SPEND_CENTS = (\d+)/)?.[1]);
    expect(perRun).toBeGreaterThan(0);
    expect(capCents).toBeGreaterThan(0);
    expect(capCents, "a daily cap this large is a wallet drain, not a refresh").toBeLessThanOrEqual(100);
    // The spend check must run BEFORE the payment, not be a report afterwards.
    expect(cron).toMatch(/const overCap = spent \+ cents > MAX_SPEND_CENTS && spent > 0;/);
    expect(cron).toMatch(/if \(attempts >= MAX_PER_RUN \|\| overCap\)/);
    // `&& spent > 0` is deliberate, not a slip: a price above the whole per-run
    // budget used to be deferred at spent = 0 on every run, forever, which
    // quietly excluded both $0.75 reports from keepalive entirely. See
    // test/cron-spend-cap.test.ts. Worst case is still cap + one price.
  });

  it("still obeys the global spend kill-switch", () => {
    expect(cron).toMatch(/if \(!getConfig\(\)\.enableBuyer\)/);
  });

  it("never buys our own credit", () => {
    // buy-credits mints spendable balance; paying for it moves money from one
    // pocket to the other and calls it a refresh.
    expect(cron).toMatch(/s\.id === "buy-credits"/);
  });

  it("uses the published example, not a guessed parameter map", () => {
    expect(cron).toMatch(/exampleInputFor\(s\)/);
    expect(cron, "the old USDC-for-everything map must be gone").not.toMatch(/function sample\(/);
  });

  it("a real customer payment counts as a refresh", () => {
    // This is what makes the bill fall as demand rises: an endpoint someone
    // actually bought is already inside the window and must not be paid for.
    expect(paid).toMatch(/kvSet\(indexFreshKey\(service\.id\), "1", INDEX_FRESH_SECONDS\)/);
    expect(indexFreshKey("token-risk")).toBe("idx:token-risk");
    // Comfortably inside the index's ~30-day window, so one missed run is safe.
    expect(INDEX_FRESH_SECONDS).toBeLessThan(30 * 24 * 3600);
    expect(INDEX_FRESH_SECONDS).toBeGreaterThan(7 * 24 * 3600);
  });

  it("is actually scheduled", () => {
    const job = vercel.crons.find((c) => c.path === "/api/cron/index-all");
    expect(job, "the cron exists but nothing runs it — the state this was in for months").toBeDefined();
    expect(job!.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  it("every service it would pay for has a runnable example", () => {
    // A service whose declared example cannot fill its required params is one
    // the cron cannot refresh AND an agent cannot call. Same defect, two costs.
    const broken: string[] = [];
    for (const s of services()) {
      const ex = exampleInputFor(s) ?? {};
      const missing = s.params.filter((p) => p.required && !ex[p.name]).map((p) => p.name);
      if (missing.length) broken.push(`${s.id} (${missing.join(",")})`);
    }
    expect(broken, `no runnable example: ${broken.join("; ")}`).toEqual([]);
  });

  it("a full sweep of the catalog stays affordable", () => {
    // The number worth knowing before scheduling anything: what it costs if
    // literally nothing sells and every listing needs refreshing. Mirrors what
    // the cron actually pays for — buy-credits is skipped, and at $5.00 it would
    // otherwise be half the bill on its own.
    const payable = services().filter((s) => s.id !== "buy-credits");
    const total = payable.reduce((n, s) => n + priceCents(s.price), 0);
    expect(total / 100, `worst-case cycle is $${(total / 100).toFixed(2)}`).toBeLessThan(8);
    // And the daily cap must be able to clear that inside one 21-day cycle, or
    // the refresh silently falls behind the window it exists to stay inside.
    const capCents = Number(cron.match(/MAX_SPEND_CENTS = (\d+)/)?.[1]);
    expect(capCents * 21).toBeGreaterThan(total);
  });
});
