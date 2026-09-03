/**
 * Offline contract tests for GET /api/x402/morpho-health.
 * No network, wallet, payment, or live seller call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MORPHO_HEALTH_RESULT_REQUIRED,
  MORPHO_HEALTH_SERVICE_ID,
  discoveryOutputFor,
  morphoHealthHttp200Schema,
  morphoHealthResultSchema,
  openApi200For,
} from "@/lib/morpho-health-output-contract";
import { staticOutputExample } from "@/lib/discovery-examples";

const REQUIRED = [...MORPHO_HEALTH_RESULT_REQUIRED];
const BORROW_ONLY = [
  "healthFactor",
  "currentLtvPct",
  "liquidationLtvPct",
  "priceDropToLiquidationPct",
  "loanToken",
  "lastAccrual",
] as const;

function missingRequired(body: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((key) => !(key in body) || body[key] === undefined);
}

function finishBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /return finish\(\{([\s\S]*?)\n\s+\}\);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) blocks.push(match[1]);
  return blocks;
}

const noBorrow: Record<string, unknown> = {
  checkedAt: "2026-09-01T00:00:00.000Z",
  wallet: "0x973A31858f4D2125f48C880542DA11a2796f12D6",
  market: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
  pair: "cbBTC/USDC",
  verdict: "no_borrow",
  collateral: "0",
  collateralToken: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  borrowed: "0",
  recommendation: "This wallet has no position (no collateral, no borrow) in this market.",
  note: "Reads a Morpho Blue lending position on Base and its liquidation health. Pass wallet= and (optionally) market=; omit market= for cbBTC/USDC. Not financial advice.",
};

const activeBorrow: Record<string, unknown> = {
  ...noBorrow,
  verdict: "healthy",
  borrowed: "1.5",
  healthFactor: 2.1,
  currentLtvPct: 40,
  liquidationLtvPct: 86,
  priceDropToLiquidationPct: 52.38,
  loanToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  lastAccrual: "2026-09-01T00:00:00.000Z",
  recommendation: "Healthy: cbBTC would need to fall 52.38% to reach liquidation (health 2.100).",
};

describe("morpho-health output contract", () => {
  it("requires only keys both morphoHealth success branches return", () => {
    expect(REQUIRED).toEqual([
      "checkedAt",
      "wallet",
      "market",
      "pair",
      "verdict",
      "collateral",
      "collateralToken",
      "borrowed",
      "recommendation",
      "note",
    ]);
    expect(morphoHealthResultSchema.required).toEqual(REQUIRED);
    for (const key of BORROW_ONLY) {
      expect(REQUIRED).not.toContain(key);
      expect(morphoHealthResultSchema.properties).toHaveProperty(key);
    }
  });

  it("accepts no_borrow and active-borrow handler payloads", () => {
    expect(missingRequired(noBorrow, REQUIRED)).toEqual([]);
    expect(missingRequired(activeBorrow, REQUIRED)).toEqual([]);
    expect(noBorrow).not.toHaveProperty("healthFactor");
  });

  it("rejects a payload missing a shared handler field", () => {
    const { wallet: _wallet, ...rest } = noBorrow;
    expect(missingRequired(rest, REQUIRED)).toEqual(["wallet"]);
  });

  it("describes HTTP 200 as the paid envelope, with handler fields under data", () => {
    expect(morphoHealthHttp200Schema.required).toEqual(["service", "data"]);
    expect(morphoHealthHttp200Schema.properties.data.required).toEqual(REQUIRED);
    const spec = openApi200For(MORPHO_HEALTH_SERVICE_ID);
    expect(spec.content["application/json"].schema).toEqual(morphoHealthHttp200Schema);
    expect(openApi200For("token-risk").content["application/json"].schema).toEqual({ type: "object" });
  });

  it("keeps the static shop-window example schema-valid after stamping checkedAt", () => {
    const raw = staticOutputExample("morpho-health");
    expect(raw).toBeTruthy();
    expect(raw).not.toHaveProperty("checkedAt");
    const out = discoveryOutputFor("morpho-health", raw);
    expect(out?.schema).toBe(morphoHealthResultSchema);
    expect(typeof out?.example?.checkedAt).toBe("string");
    expect(missingRequired(out!.example as Record<string, unknown>, REQUIRED)).toEqual([]);
  });

  it("does not alter discovery output for other services", () => {
    const example = { pair: "BTC-USD" };
    expect(discoveryOutputFor("token-risk", example)).toEqual({ example });
    expect(discoveryOutputFor("token-risk", undefined)).toBeUndefined();
  });

  it("projects the handler required fields onto the Bazaar example schema", async () => {
    const { declareDiscoveryExtension } = await import("@x402/extensions/bazaar");
    const out = discoveryOutputFor("morpho-health", staticOutputExample("morpho-health"));
    const ext = declareDiscoveryExtension({
      input: { wallet: "0x973A31858f4D2125f48C880542DA11a2796f12D6" },
      inputSchema: {
        type: "object",
        properties: { wallet: { type: "string" } },
        required: ["wallet"],
      },
      output: out,
    });
    const exampleSchema = ext.bazaar.schema.properties.output?.properties?.example as {
      required?: string[];
    };
    expect(exampleSchema.required).toEqual(REQUIRED);
  });
});

describe("morpho-health source wiring", () => {
  it("both morphoHealth finish() branches include the shared keys", () => {
    const src = readFileSync(new URL("../src/lib/morpho.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function morphoHealth"), src.indexOf("function positionHealth"));
    const blocks = finishBlocks(fn);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toMatch(/verdict:\s*"no_borrow"/);
    expect(blocks[1]).toMatch(/healthFactor:/);
    for (const block of blocks) {
      for (const key of REQUIRED.filter((k) => k !== "checkedAt")) {
        expect(block, `missing ${key} on a success branch`).toMatch(new RegExp(`\\b${key}\\b`));
      }
      if (block.includes('verdict: "no_borrow"')) {
        for (const key of BORROW_ONLY) {
          expect(block).not.toMatch(new RegExp(`\\b${key}:`));
        }
      }
    }
  });

  it("OpenAPI and the x402 route project this contract", () => {
    const openapi = readFileSync(new URL("../src/app/api/openapi/route.ts", import.meta.url), "utf8");
    expect(openapi).toMatch(/openApi200For\(s\.id\)/);
    expect(openapi).not.toMatch(/"application\/json": \{ schema: \{ type: "object" \} \}/);

    const route = readFileSync(new URL("../src/app/api/x402/[service]/route.ts", import.meta.url), "utf8");
    expect(route).toMatch(/discoveryOutputFor\(service\.id, outputExample\)/);
    expect(route).toMatch(/discoveryOutput \? \{ output: discoveryOutput \}/);
  });

  it("does not change morpho-health price, method, or query contract", () => {
    const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
    const chunk = src.split(/\r?\n {2}\{\r?\n/).find((c) => /id:\s*"morpho-health"/.test(c));
    expect(chunk).toBeTruthy();
    expect(chunk).toMatch(/price:\s*"\$0\.04"/);
    expect(chunk).toMatch(/name:\s*"wallet"/);
    expect(chunk).toMatch(/required:\s*true/);
    expect(chunk).toMatch(/name:\s*"market"/);
    expect(chunk).toMatch(/handler:\s*morphoHealth/);
  });
});
