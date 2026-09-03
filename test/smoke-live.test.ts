/**
 * Live smoke run over the whole catalog — OFF by default, `SMOKE=1` turns it on.
 *
 * Every other test in here is hermetic. This one is the opposite on purpose: it
 * calls each service's real handler against its real upstream, with the example
 * input we publish for it, and reports what came back. It exists because the
 * failures it catches are invisible to the hermetic suite and to typecheck — an
 * upstream that changed a field name, a free API tier that started rejecting us,
 * a chain RPC that dropped a method. Those only show up when someone pays for
 * the endpoint, which is the worst moment to find out.
 *
 * It runs the HANDLER, not the route, so nothing settles and nothing is billed.
 * The trade-off is that anything the handler needs from the deployment rather
 * than from source — KV, the stats token — is absent locally, so a service that
 * writes to KV reports its own degradation here rather than a real fault. That
 * distinction is in the report, not left to the reader.
 *
 *   SMOKE=1 npx vitest run test/smoke-live.test.ts
 *   SMOKE=1 SMOKE_AI=1 …   also runs the 11 AI services (spends Anthropic credit)
 *   SMOKE=1 SMOKE_ONLY=b20-peg,token-risk …  just those
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const RUN = process.env.SMOKE === "1";
/** AI handlers cost real money per call, so they are opt-in on top of opt-in. */
const RUN_AI = process.env.SMOKE_AI === "1";
const ONLY = (process.env.SMOKE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Mints a spendable balance — never call it from a test harness. */
const NEVER_CALL = new Set(["buy-credits"]);

/** How long one handler gets before we call it hung. Generous: several compose
 *  a dozen RPC reads, and slow is a finding, not a failure. */
const TIMEOUT_MS = 60_000;
/** Concurrent handlers. Low enough not to trip upstream per-IP limits, which
 *  would report as endpoint faults that are really our own stampede. */
const BATCH = 5;

/** Next loads `.env.local` for us in dev; vitest does not. Parse it directly
 *  rather than adding a dependency for one file. */
function loadEnvLocal(): void {
  const file = path.resolve(__dirname, "..", ".env.local");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

type Outcome = {
  id: string;
  category: string;
  price: string;
  status: "ok" | "degraded" | "empty" | "threw" | "timeout" | "skipped";
  ms: number;
  detail: string;
  keys?: string[];
};

/** A handler can fail without throwing. These are the shapes that mean "we
 *  answered, but not with the thing the buyer paid for". */
function classify(data: unknown): { status: Outcome["status"]; detail: string; keys: string[] } {
  if (data === null || data === undefined) return { status: "empty", detail: "handler returned null/undefined", keys: [] };
  if (typeof data !== "object") return { status: "ok", detail: `scalar: ${String(data).slice(0, 60)}`, keys: [] };
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return { status: "empty", detail: "handler returned {}", keys };
  if (rec.degraded === true) {
    const missing = Array.isArray(rec.missing) ? (rec.missing as unknown[]).join(",") : "";
    return { status: "degraded", detail: `degraded:true${missing ? ` missing=[${missing}]` : ""}`, keys };
  }
  // A receipt-carrying refusal is the same event under the decision-receipt name.
  const receipt = rec.receipt as { refusal?: { reason?: string } | null; confidence?: { band?: string } } | undefined;
  if (receipt?.refusal) return { status: "degraded", detail: `refusal: ${receipt.refusal.reason ?? "?"}`, keys };
  if (typeof rec.error === "string") return { status: "degraded", detail: `error field: ${rec.error.slice(0, 80)}`, keys };
  return { status: "ok", detail: `${keys.length} keys`, keys };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref?.()),
  ]);
}

describe.skipIf(!RUN)("live catalog smoke", () => {
  it(
    "calls every service handler with its published example input",
    async () => {
      loadEnvLocal();
      const { SERVICES } = await import("../src/lib/services");
      const { exampleInputFor } = await import("../src/lib/discovery-examples");

      const targets = SERVICES.filter((s) => {
        if (NEVER_CALL.has(s.id)) return false;
        if (ONLY.length) return ONLY.includes(s.id);
        if (s.category === "AI" && !RUN_AI) return false;
        return true;
      });

      const results: Outcome[] = [];
      for (let i = 0; i < targets.length; i += BATCH) {
        const slice = targets.slice(i, i + BATCH);
        const settled = await Promise.all(
          slice.map(async (s): Promise<Outcome> => {
            const base = { id: s.id, category: s.category, price: s.price };
            const params = exampleInputFor(s) ?? {};
            const started = Date.now();
            try {
              const data = await withTimeout(Promise.resolve(s.handler(params)), TIMEOUT_MS);
              const { status, detail, keys } = classify(data);
              return { ...base, status, ms: Date.now() - started, detail, keys };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                ...base,
                status: /^timeout after/.test(message) ? "timeout" : "threw",
                ms: Date.now() - started,
                detail: message.slice(0, 200),
              };
            }
          }),
        );
        results.push(...settled);
        // eslint-disable-next-line no-console
        console.log(
          settled
            .map((r) => `${r.status.padEnd(8)} ${String(r.ms).padStart(6)}ms  ${r.id.padEnd(26)} ${r.detail}`)
            .join("\n"),
        );
      }

      const bad = results.filter((r) => r.status === "threw" || r.status === "timeout" || r.status === "empty");
      const degraded = results.filter((r) => r.status === "degraded");
      const report = {
        ranAt: new Date().toISOString(),
        total: results.length,
        ok: results.length - bad.length - degraded.length,
        degraded: degraded.length,
        broken: bad.length,
        results: results.sort((a, b) => a.status.localeCompare(b.status) || b.ms - a.ms),
      };
      // `_`-prefixed: gitignored as local scratch, so a run never dirties the tree.
      writeFileSync(path.resolve(__dirname, "..", "_smoke-report.json"), JSON.stringify(report, null, 2));

      // eslint-disable-next-line no-console
      console.log(
        `\n=== ${report.ok}/${report.total} ok · ${report.degraded} degraded · ${report.broken} broken ===\n` +
          bad.map((r) => `BROKEN  ${r.id}: ${r.detail}`).join("\n"),
      );
      expect(results.length).toBeGreaterThan(0);
    },
    // The whole sweep, not one handler.
    30 * 60_000,
  );
});
