import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Workflows run through the REAL paid route.
 *
 * The terminal and workflow runner this replaces ran paid handlers directly and
 * printed whatever it liked. These tests drive POST /api/workflows/run, which
 * hands each step to the GET handler of /api/x402/[service] — the code a direct
 * paid call reaches. Only the catalogue (fake handlers, real prices) and the
 * credit ledger's storage (an in-memory balance instead of Redis) are replaced,
 * so every charge and refund below is made by the route's own credit path.
 */

const ledger = new Map<string, number>(); // token → spendable mills
const debits: Array<{ token: string; mills: number; ok: boolean }> = [];
const refunds: Array<{ token: string; mills: number }> = [];
const calls: Array<{ service: string; params: Record<string, string> }> = [];

const STOP_TOKEN = "0x" + "d".repeat(40);
const ADDR = "0x" + "a".repeat(40);
const TOKEN = "ck_" + "a".repeat(36);

vi.mock("@/lib/credits", async () => {
  const actual = await vi.importActual<typeof import("@/lib/credits")>("@/lib/credits");
  return {
    ...actual,
    debitCreditMills: async (token: string, mills: number) => {
      const bal = ledger.get(token);
      if (bal === undefined) {
        debits.push({ token, mills, ok: false });
        return { ok: false, remainingMills: 0, reason: "bad_token", balanceMills: 0 };
      }
      if (bal < mills) {
        debits.push({ token, mills, ok: false });
        return { ok: false, remainingMills: 0, reason: "insufficient", balanceMills: bal };
      }
      ledger.set(token, bal - mills);
      debits.push({ token, mills, ok: true });
      return { ok: true, remainingMills: bal - mills };
    },
    refundCreditMills: async (token: string, mills: number) => {
      refunds.push({ token, mills });
      ledger.set(token, (ledger.get(token) ?? 0) + mills);
    },
    creditBalance: async (token: string) => Math.floor((ledger.get(token) ?? 0) / 10),
  };
});

vi.mock("@/lib/services", () => {
  const rec = (service: string, params: Record<string, string>) => calls.push({ service, params: { ...params } });
  const SERVICES = [
    {
      id: "token-risk",
      name: "Token Risk",
      tagline: "",
      description: "",
      price: "$0.03",
      icon: "",
      category: "Onchain",
      noFreeTier: true,
      params: [{ name: "address", label: "Token", placeholder: "", required: true }],
      handler: async (p: Record<string, string>) => {
        rec("token-risk", p);
        return { address: p.address.toLowerCase(), riskLevel: "low", receipt: { decision: p.address.toLowerCase() === STOP_TOKEN ? "STOP" : "GO" } };
      },
    },
    {
      id: "sellability",
      name: "Sellability",
      tagline: "",
      description: "",
      price: "$0.08",
      icon: "",
      category: "Onchain",
      noFreeTier: true,
      params: [
        { name: "address", label: "Token", placeholder: "", required: true },
        { name: "size", label: "Size", placeholder: "" },
      ],
      handler: async (p: Record<string, string>) => {
        rec("sellability", p);
        return { address: p.address, canSell: true, receipt: { decision: "GO" } };
      },
    },
    {
      id: "swap-route",
      name: "Swap Route",
      tagline: "",
      description: "",
      price: "$0.03",
      icon: "",
      category: "Markets",
      noFreeTier: true,
      params: [
        { name: "tokenOut", label: "Token", placeholder: "", required: true },
        { name: "amountUsd", label: "USD", placeholder: "" },
      ],
      handler: async (p: Record<string, string>) => {
        rec("swap-route", p);
        return { tokenOut: p.tokenOut, amountUsd: p.amountUsd ?? null };
      },
    },
    {
      id: "boom",
      name: "Boom",
      tagline: "",
      description: "",
      price: "$0.05",
      icon: "",
      category: "Onchain",
      params: [{ name: "address", label: "Token", placeholder: "", required: true }],
      handler: async (p: Record<string, string>) => {
        rec("boom", p);
        throw new Error("Token data unavailable: upstream exploded");
      },
    },
    {
      id: "drain",
      name: "Drain",
      tagline: "",
      description: "",
      price: "$0.01",
      icon: "",
      category: "Onchain",
      params: [],
      // Another client spending the same token while this run is in flight.
      handler: async (p: Record<string, string>) => {
        rec("drain", p);
        ledger.set(TOKEN, 0);
        return { ok: true };
      },
    },
    {
      id: "buy-credits",
      name: "Buy credits",
      tagline: "",
      description: "",
      price: "$5",
      icon: "",
      category: "Utility",
      params: [{ name: "tier", label: "Tier", placeholder: "" }],
      handler: async () => ({}),
    },
  ];
  const getService = (id: string) => SERVICES.find((s) => s.id === id);
  return {
    SERVICES,
    getService,
    ONCHAIN_SERVICES: [],
    B20_SERVICES: [],
    NEAR_SERVICES: [],
    AI_SERVICES: [],
    MARKETS_SERVICES: [],
    BUSINESS_SERVICES: [],
    UTILITY_SERVICES: [],
  };
});

const { POST } = await import("@/app/api/workflows/run/route");
const { GET: listGET } = await import("@/app/api/workflows/route");
const { parseValue, resolvePath, planWorkflow } = await import("@/lib/workflows");
const { effectivePriceFor } = await import("@/lib/effective-price");
const { getService } = await import("@/lib/services");
const { priceMills } = await import("@/lib/price");

let ipSeq = 0;
function run(body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ipSeq % 250}` };
  if (token) headers["x-credit-token"] = token;
  return POST(new NextRequest("https://402.test/api/workflows/run", { method: "POST", headers, body: JSON.stringify(body) }));
}

const totalDebitedMills = () => debits.filter((d) => d.ok).reduce((n, d) => n + d.mills, 0) - refunds.reduce((n, r) => n + r.mills, 0);

beforeEach(() => {
  ledger.clear();
  debits.length = 0;
  refunds.length = 0;
  calls.length = 0;
  ledger.set(TOKEN, 1000); // $1.00
});

describe("quote", () => {
  it("a dry run quotes the sum of the step prices, from the route's own price function, and charges nothing", async () => {
    const res = await run({ template: "pre-buy", input: { address: ADDR }, dryRun: true });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.charged).toBe(false);
    expect(j.quote.steps.map((s: { service: string }) => s.service)).toEqual(["token-risk", "sellability", "swap-route"]);

    let sum = 0;
    for (const s of j.quote.steps as Array<{ service: string; priceUsd: number }>) {
      const viaRoute = await effectivePriceFor(getService(s.service)!, new NextRequest(`https://402.test/api/x402/${s.service}`));
      expect(s.priceUsd).toBe(priceMills(viaRoute) / 1000);
      sum += priceMills(viaRoute);
    }
    expect(j.quote.totalMills).toBe(sum);
    expect(j.quote.totalUsd).toBeCloseTo(0.14, 6);
    expect(j.sufficient).toBe(true);
    expect(debits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(ledger.get(TOKEN)).toBe(1000);
  });

  it("GET /api/workflows?template=…&quote=1 gives the same number", async () => {
    const res = await listGET(new NextRequest(`https://402.test/api/workflows?template=pre-buy&quote=1&address=${ADDR}`));
    const j = await res.json();
    expect(j.quote.totalMills).toBe(140);
    expect(j.charged).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("lists the templates", async () => {
    const j = await (await listGET(new NextRequest("https://402.test/api/workflows"))).json();
    expect(j.templates.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["pre-buy", "wallet-dd", "near-pre-trade"]));
  });
});

describe("validation happens before anything is charged", () => {
  it("rejects an unknown service in a later step without debiting the earlier ones", async () => {
    const res = await run({ steps: [{ service: "token-risk", params: { address: ADDR } }, { service: "no-such-service", params: {} }] });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/no-such-service/);
    expect(j.charged).toBe(false);
    expect(debits).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown parameters, missing required ones, buy-credits and more than five steps", async () => {
    for (const steps of [
      [{ service: "token-risk", params: { addr: ADDR } }],
      [{ service: "token-risk", params: {} }],
      [{ service: "buy-credits", params: { tier: "5" } }],
      Array.from({ length: 6 }, () => ({ service: "token-risk", params: { address: ADDR } })),
    ]) {
      const res = await run({ steps });
      expect(res.status).toBe(400);
    }
    expect(debits).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses without a credit token, and a balance below the quote, before calling anything", async () => {
    expect((await run({ template: "pre-buy", input: { address: ADDR } }, null)).status).toBe(402);
    ledger.set(TOKEN, 100); // $0.10 < $0.14
    const res = await run({ template: "pre-buy", input: { address: ADDR } });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/Insufficient credits.*Nothing was charged/);
    expect(debits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(ledger.get(TOKEN)).toBe(100);
  });
});

describe("running", () => {
  it("charges each step through the paid route, exactly its price", async () => {
    const res = await run({ template: "pre-buy", input: { address: ADDR, amountUsd: "500" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.completed).toBe(true);
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(j.steps.map((s: { chargedUsd: number }) => s.chargedUsd)).toEqual([0.03, 0.08, 0.03]);
    expect(j.totalChargedUsd).toBeCloseTo(0.14, 6);
    expect(debits.map((d) => d.mills)).toEqual([30, 80, 30]);
    expect(ledger.get(TOKEN)).toBe(860);
    expect(j.creditBalanceUsd).toBe(0.86);
    // Each output is the paid route's own response body.
    expect(j.steps[0].output.paidVia).toBe("credits");
    expect(calls.find((c) => c.service === "swap-route")!.params).toEqual({ tokenOut: ADDR, amountUsd: "500" });
  });

  it("insufficient credit mid-run: the failing step is not charged, later steps are not called", async () => {
    const res = await run({
      steps: [
        { service: "token-risk", params: { address: ADDR } },
        { service: "drain" },
        { service: "sellability", params: { address: ADDR } },
        { service: "swap-route", params: { tokenOut: ADDR } },
      ],
    });
    expect(res.status).toBe(402);
    const j = await res.json();
    expect(j.insufficientCredits).toBe(true);
    expect(j.haltReason).toMatch(/insufficient credits at step 3/);
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "ok", "failed", "skipped"]);
    expect(j.steps[2].error).toBe("Insufficient credits");
    expect(j.steps[2].chargedUsd).toBe(0);
    expect(j.steps[3].chargedUsd).toBe(0);
    expect(j.totalChargedUsd).toBeCloseTo(0.04, 6);
    expect(calls.map((c) => c.service)).toEqual(["token-risk", "drain"]);
    // swap-route was never even attempted against the balance.
    expect(debits.map((d) => d.mills)).toEqual([30, 10, 80]);
    expect(debits[2].ok).toBe(false);
  });

  it("a STOP decision halts the run; later steps are not called and not charged", async () => {
    const res = await run({ template: "pre-buy", input: { address: STOP_TOKEN } });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.steps[0].decision).toBe("STOP");
    expect(j.haltReason).toMatch(/step 1 \(token-risk\) returned decision STOP/);
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "skipped", "skipped"]);
    expect(j.totalChargedUsd).toBeCloseTo(0.03, 6);
    expect(debits.map((d) => d.mills)).toEqual([30]);
    expect(calls.map((c) => c.service)).toEqual(["token-risk"]);
    expect(ledger.get(TOKEN)).toBe(970);
  });

  it("stopOnStop:false runs on past a STOP", async () => {
    const j = await (await run({ template: "pre-buy", input: { address: STOP_TOKEN }, stopOnStop: false })).json();
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(totalDebitedMills()).toBe(140);
  });

  it("a step whose handler throws is refunded by the route, as in a direct call, and the run stops", async () => {
    const res = await run({
      steps: [
        { service: "token-risk", params: { address: ADDR } },
        { service: "boom", params: { address: ADDR } },
        { service: "swap-route", params: { tokenOut: ADDR } },
      ],
    });
    const j = await res.json();
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "failed", "skipped"]);
    expect(j.steps[1].httpStatus).toBeGreaterThanOrEqual(400);
    expect(j.steps[1].error).toMatch(/upstream exploded/);
    expect(j.steps[1].chargedUsd).toBe(0);
    expect(refunds).toEqual([{ token: TOKEN, mills: 50 }]);
    expect(ledger.get(TOKEN)).toBe(970);
    expect(j.totalChargedUsd).toBeCloseTo(0.03, 6);
    expect(calls.map((c) => c.service)).toEqual(["token-risk", "boom"]);
  });
});

describe("references", () => {
  it("passes a value from an earlier step's response into a later step", async () => {
    const res = await run({
      steps: [
        { service: "token-risk", params: { address: ADDR.toUpperCase().replace("0X", "0x") } },
        { service: "sellability", params: { address: "$1.data.address", size: "$1.data.riskLevel" } },
      ],
    });
    const j = await res.json();
    expect(j.completed).toBe(true);
    expect(calls[1].params).toEqual({ address: ADDR, size: "low" });
    expect(j.steps[1].params.address).toBe(ADDR);
  });

  it("parses only the tiny grammar", () => {
    expect(parseValue("$1.data.address")).toEqual({ kind: "step", step: 1, path: ["data", "address"] });
    expect(parseValue("$input.address")).toEqual({ kind: "input", name: "address" });
    expect(parseValue("$$5")).toEqual({ kind: "literal", value: "$5" });
    expect(parseValue("plain")).toEqual({ kind: "literal", value: "plain" });
    for (const bad of [
      "$1.__proto__.polluted",
      "$1.constructor.name",
      "$1.data.prototype",
      "${process.env.SECRET}",
      "$1.data.address;process.exit()",
      "$1.data[0]",
      "$1.data.address()",
      "$0.data",
      "$1",
      "$foo.bar",
      "$input",
      "$input.a.b",
      "$1." + Array(10).fill("a").join("."),
    ]) {
      expect(parseValue(bad).kind, bad).toBe("error");
    }
    expect(parseValue({ toString: () => "x" }).kind).toBe("error");
  });

  it("walks own fields only", () => {
    const out = { data: { address: "0xabc", list: ["a", "b"], nested: { n: 3 } } };
    expect(resolvePath(out, ["data", "address"])).toEqual({ ok: true, value: "0xabc" });
    expect(resolvePath(out, ["data", "list", "1"])).toEqual({ ok: true, value: "b" });
    expect(resolvePath(out, ["data", "nested", "n"])).toEqual({ ok: true, value: "3" });
    expect(resolvePath(out, ["data", "toString"]).ok).toBe(false);
    expect(resolvePath(out, ["data", "hasOwnProperty"]).ok).toBe(false);
    expect(resolvePath(out, ["data", "nested"]).ok).toBe(false); // objects are not scalars
    expect(resolvePath(out, ["data", "list", "9"]).ok).toBe(false);
  });

  it("rejects injection and forward references before anything is charged", async () => {
    for (const address of ["$1.__proto__.x", "${process.env}", "$2.data.address", "$1.data.address && rm"]) {
      const res = await run({
        steps: [
          { service: "token-risk", params: { address: ADDR } },
          { service: "sellability", params: { address } },
        ],
      });
      expect(res.status, address).toBe(400);
    }
    expect(planWorkflow({ steps: [{ service: "token-risk", params: { address: "$1.data.address" } }] }).ok).toBe(false);
    expect(debits).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // Nothing leaked onto prototypes.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("a reference that does not resolve at run time stops the run before that step is called", async () => {
    const j = await (
      await run({
        steps: [
          { service: "token-risk", params: { address: ADDR } },
          { service: "sellability", params: { address: "$1.data.toString" } },
          { service: "swap-route", params: { tokenOut: ADDR } },
        ],
      })
    ).json();
    expect(j.steps.map((s: { status: string }) => s.status)).toEqual(["ok", "failed", "skipped"]);
    expect(j.steps[1].error).toMatch(/could not be resolved.*not charged/);
    expect(debits.map((d) => d.mills)).toEqual([30]);
  });
});
