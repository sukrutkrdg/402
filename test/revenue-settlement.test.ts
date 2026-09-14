import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Money that arrived is not money that was earned.
 *
 * The revenue scan reads USDC `Transfer` logs where `to == payTo`, which is
 * every way funds can reach the wallet, and it counted all of them as income.
 * On 2026-09-14 the operator moved funds off Base through a relay bridge and
 * the dashboard reported $8.89 of revenue: 5 USDC they had sent themselves from
 * our own buyer wallet by plain `transfer`, and 3.89 the bridge's solver
 * delivered by `transferFrom` under an allowance. Nobody had bought anything.
 *
 * The distinction lives in the transaction, not the log. An x402 settlement is
 * EIP-3009 — the payer signs an authorization and the facilitator submits it —
 * so the call is `transferWithAuthorization` (0xe3ee160e) or
 * `receiveWithAuthorization` (0xef55bec6). Verified on chain the same day
 * against three known settlements (a $1 credit pack, a $0.10 pre-trade-gate
 * call, a $0.002 keepalive): all three carry 0xe3ee160e, while the bridge
 * delivery carried 0x23b872dd and the manual transfer 0xa9059cbb.
 *
 * This matters beyond one wrong tile. Revenue is the number every decision about
 * this business is made against, and a figure that moves when the operator
 * rearranges their own wallets is not measuring the business at all.
 */

const lib = readFileSync("src/lib/revenue.ts", "utf8");
const panel = readFileSync("src/components/Stats.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(lib);

describe("revenue counts settlements, not arrivals", () => {
  it("recognises both EIP-3009 entry points as a settlement", () => {
    expect(code).toMatch(/0xe3ee160e/); // transferWithAuthorization
    expect(code).toMatch(/0xef55bec6/); // receiveWithAuthorization
  });

  it("names the two ways money arrives without a sale, so they read as themselves", () => {
    expect(code).toMatch(/"0xa9059cbb":\s*"transfer"/);
    expect(code).toMatch(/"0x23b872dd":\s*"transferFrom"/);
  });

  it("reports what was sold apart from what arrived, without discarding either", () => {
    expect(code, "the chain total is still the chain total").toMatch(/totalUsdc:\s*formatUnits\(total, 6\)/);
    expect(code).toMatch(/settledUsdc:/);
    expect(code).toMatch(/nonSettlementUsdc:/);
  });

  it("only counts a payment as settled when it was positively identified as one", () => {
    expect(code).toMatch(/isSettlement:\s*method === "x402"/);
    // Not `method !== "transfer"` — an unrecognised selector must not fall
    // through into revenue. Anything we could not read should understate income
    // rather than invent it, which is the direction the old bug got wrong.
    expect(code).not.toMatch(/isSettlement:\s*method\s*!==/);
  });

  it("treats an unreadable transaction as unknown rather than as a sale", () => {
    expect(code).toMatch(/out\.set\(h, "unknown"\)/);
  });

  /**
   * A transaction's method is immutable, and this route backs a polled panel —
   * without caching, every refresh would re-fetch up to a hundred transactions.
   */
  it("caches the classification, because it can never change", () => {
    expect(code).toMatch(/kvGet\(`tx:method:\$\{h\}`\)/);
    expect(code).toMatch(/kvSet\(`tx:method:\$\{h\}`/);
  });

  it("leads the panel with settled revenue and labels the rest as not revenue", () => {
    expect(panel).toMatch(/settledUsdc/);
    expect(panel).toMatch(/arrived without a sale/);
    expect(panel).toMatch(/Not revenue/);
  });
});

/**
 * The hostname we advertise must be the one that serves.
 *
 * Adding `www` to the origin project on 2026-09-15 made it primary and turned
 * the apex into a 308 toward it. Every URL we publish names the apex — 161
 * catalogue endpoints, every `resource.url` in a 402 challenge, the discovery
 * records, npm, the MCP manifests — so every agent following our own address
 * took a redirect to reach us. Payments still settled, which is precisely why
 * nothing noticed: the exposure is in clients that do not follow redirects, in
 * clients that drop headers across a host change, and in any verifier comparing
 * the advertised resource URL against the one that answered.
 */
describe("canonical host", () => {
  const surface = readFileSync("src/lib/surface-check.ts", "utf8");

  it("compares the host that answered against the host we publish", () => {
    const code = strip(surface);
    expect(code).toMatch(/new URL\(r\.url\)\.host/);
    expect(code).toMatch(/new URL\(SITE\)\.host/);
    expect(code).toMatch(/served !== advertised/);
  });

  it("follows redirects before judging, so http→https is not a failure", () => {
    expect(strip(surface)).toMatch(/redirect:\s*"follow"/);
  });

  it("fails the check rather than only mentioning it", () => {
    expect(strip(surface)).toMatch(/deadHosts\.length === 0 && !canonical/);
  });
});
