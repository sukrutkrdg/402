import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_NETWORKS, EXTRA_NETWORKS, NETWORK } from "@/lib/config";

/**
 * The challenge has to be payable by clients that are not ours.
 *
 * Every test we had proved that *our* buyer could pay, and our buyer registers
 * exactly one network (`client.register(NETWORK, …)` in x402-client.ts). Handed
 * a challenge quoting Base and Polygon it never experiences a choice: it has
 * already decided, matches the Base entry, and settles. So the suite, the daily
 * SMOKE sweep and the keepalive cron all confirmed "payable" while a class of
 * third-party client could not pay us at all.
 *
 * A routing client reported exactly that on 2026-09-11: it binds one route to
 * one network, saw two in a single `accepts[]`, marked `ai-translate`
 * unbindable and settled a competitor at a sixth of the price. We had no way to
 * observe it — the failure lives in the gap between our client's assumptions
 * and someone else's.
 *
 * So this asserts the property an outside client depends on, rather than the
 * outcome our own client happens to get. That is the general lesson from this
 * and from the free-tier claim an outside reader found two days earlier: a test
 * written against our own assumptions cannot fail for a reason our assumptions
 * exclude.
 */

describe("one resource quotes one network", () => {
  it("offers a single entry, so a binding client has nothing to resolve", () => {
    expect(ALL_NETWORKS).toHaveLength(1);
    expect(ALL_NETWORKS[0]).toBe(NETWORK);
  });

  it("keeps Polygon out entirely", () => {
    expect(EXTRA_NETWORKS).toEqual([]);
    expect(ALL_NETWORKS).not.toContain("eip155:137");
  });

  /**
   * Adding a network is a real decision with a cost on the buyer side, so it
   * should be a deliberate edit here rather than something that arrives with a
   * dependency bump or a copied line. If this ever needs to fail, the thing to
   * think about first is whether every client that reads the challenge can
   * still pick without guessing.
   */
  it("makes a second network an explicit choice, not an accident", () => {
    const cfg = readFileSync("src/lib/config.ts", "utf8");
    expect(cfg).toMatch(/export const EXTRA_NETWORKS: Network\[\] = \[\];/);
    // The challenge builds from ALL_NETWORKS, so nothing can add a chain
    // without going through the list this test reads.
    const route = readFileSync("src/app/api/x402/[service]/route.ts", "utf8");
    expect(route).toMatch(/accepts: ALL_NETWORKS\.map/);
    expect(route, "a hardcoded chain id would bypass the guard").not.toMatch(/eip155:137/);
  });

  it("registers the seller on exactly the networks it advertises", () => {
    // Advertising a chain the resource server cannot settle would be worse than
    // advertising none: the payer signs, and then nothing clears.
    const server = readFileSync("src/lib/x402-server.ts", "utf8");
    expect(server).toMatch(/for \(const net of ALL_NETWORKS\) server = server\.register\(net/);
  });
});
