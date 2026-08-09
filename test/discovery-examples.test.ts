import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { exampleInputFor, staticOutputExample, staticOutputExampleIds, type ExampleService } from "../src/lib/discovery-examples";

/**
 * The declared example is the only instruction an agent gets before it pays, and
 * a wrong one costs a customer silently: the call errors, and nothing tells us.
 *
 * Both failures this guards against were live in August 2026. Every parameter
 * whose NAME matched /address|token|wallet|contract|owner|spender/ was declared
 * as the USDC contract — so 54 examples put a token where a wallet belongs, and
 * all 29 B20 endpoints advertised USDC, which is not a B20 and makes each one
 * answer "not a B20 token". The rest were declared as their UI placeholder, so
 * 34 read `hash: "0x… 32-byte tx hash"` — an ellipsis is not a value.
 *
 * Services are parsed out of the source rather than imported: the registry pulls
 * in every server-only handler behind it.
 */
function parseServices(): ExampleService[] {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  // \r optional: the file is LF in git, but a Windows checkout makes it CRLF and
  // a guard that silently parses zero services is worse than no guard.
  const chunks = src.split(/\r?\n {2}\{\r?\n/).slice(1);
  const out: ExampleService[] = [];
  for (const chunk of chunks) {
    const body = chunk.split(/\r?\n {2}\},?\r?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    if (!id || /^\s*\/\//.test(body)) continue;
    const params: ExampleService["params"] = [...body.matchAll(/\{[^{}]*\bname:\s*"(\w+)"[^{}]*\}/g)].map((m) => ({
      name: m[1],
      label: m[0].match(/label:\s*"([^"]*)"/)?.[1] ?? "",
      placeholder: m[0].match(/placeholder:\s*"([^"]*)"/)?.[1] ?? "",
      required: /required:\s*true/.test(m[0]),
    }));
    out.push({ id, category: body.match(/^\s*category:\s*"([^"]+)"/m)?.[1], params });
  }
  return out;
}

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Contract addresses that must never be offered as somebody's wallet. */
const TOKENS = [USDC, "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", "0xb20000000000000000000186a08e781c38059eec"];

describe("declared examples are callable", () => {
  it("parses the registry", () => {
    const services = parseServices();
    expect(services.length).toBeGreaterThan(100);
    for (const known of ["token-risk", "b20-supply", "base-tx", "wallet-summary"]) {
      expect(services.map((s) => s.id)).toContain(known);
    }
  });

  it("gives every required parameter a value", () => {
    // A required parameter left out of the example makes the example unrunnable,
    // which is the whole failure this file exists to prevent.
    const missing: string[] = [];
    for (const s of parseServices()) {
      const ex = exampleInputFor(s) ?? {};
      for (const p of s.params) if (p.required && !ex[p.name]) missing.push(`${s.id}.${p.name}`);
    }
    expect(missing, `no example value: ${missing.join(", ")}`).toEqual([]);
  });

  it("never declares a placeholder hint as a value", () => {
    const hints: string[] = [];
    for (const s of parseServices()) {
      for (const [name, v] of Object.entries(exampleInputFor(s) ?? {})) {
        if (/…|\.\.\./.test(v) || v.trim() === "") hints.push(`${s.id}.${name}="${v}"`);
      }
    }
    expect(hints, `these are form hints, not values: ${hints.join(", ")}`).toEqual([]);
  });

  it("never offers a token contract where a wallet belongs", () => {
    const wrong: string[] = [];
    for (const s of parseServices()) {
      const ex = exampleInputFor(s) ?? {};
      for (const p of s.params) {
        const v = ex[p.name];
        if (!v) continue;
        const walletish = /wallet|holder|payer|borrower|victim|account|safe/i.test(p.label);
        if (walletish && TOKENS.some((t) => v.toLowerCase().includes(t.toLowerCase()))) {
          wrong.push(`${s.id}.${p.name} (label "${p.label}")`);
        }
      }
    }
    expect(wrong, `token contract declared as a wallet: ${wrong.join(", ")}`).toEqual([]);
  });

  it("never sends USDC to a B20 endpoint", () => {
    // USDC is a plain ERC-20. Every B20 endpoint answers "not a B20 token" for
    // it, so the example makes a working endpoint look broken.
    const wrong: string[] = [];
    for (const s of parseServices()) {
      if (s.category !== "B20") continue;
      for (const [name, v] of Object.entries(exampleInputFor(s) ?? {})) {
        if (v.toLowerCase().includes(USDC.toLowerCase())) wrong.push(`${s.id}.${name}`);
      }
    }
    expect(wrong, `USDC is not a B20: ${wrong.join(", ")}`).toEqual([]);
  });
});

describe("static output examples", () => {
  it("belong to services that still exist", () => {
    const ids = new Set(parseServices().map((s) => s.id));
    const orphans = staticOutputExampleIds().filter((id) => !ids.has(id));
    expect(orphans, `example for a service that is gone: ${orphans.join(", ")}`).toEqual([]);
  });

  it("carry no frozen timestamp", () => {
    // A captured "checkedAt" would advertise the day this file was written for
    // as long as it ships — a stale date reads as an abandoned endpoint.
    const stale: string[] = [];
    for (const id of staticOutputExampleIds()) {
      for (const k of Object.keys(staticOutputExample(id) ?? {})) {
        // guardSince counts: for a caller it is when their own guard went up,
        // but in a captured example it is only when the capture ran.
        if (/^(checkedAt|generatedAt|at|guardSince)$/.test(k)) stale.push(`${id}.${k}`);
      }
    }
    expect(stale, `drop these frozen stamps: ${stale.join(", ")}`).toEqual([]);
  });

  it("answer something, rather than echoing the call back", () => {
    // The oracle reads output_keys. An example made only of the parameters it
    // was called with is the "returns nothing" that got us skipped in the first
    // place, so each one has to carry at least one key the caller did not send.
    const byId = new Map(parseServices().map((s) => [s.id, new Set(s.params.map((p) => p.name))]));
    const thin: string[] = [];
    for (const id of staticOutputExampleIds()) {
      const keys = Object.keys(staticOutputExample(id) ?? {});
      const answered = keys.filter((k) => !byId.get(id)?.has(k));
      if (answered.length === 0) thin.push(`${id} (${keys.join(",") || "empty"})`);
    }
    expect(thin, `only echoes its input: ${thin.join(", ")}`).toEqual([]);
  });
});
