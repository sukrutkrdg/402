import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every endpoint whose `description` grew past ~500 characters stopped being
 * payable: the CDP facilitator rejected the payment at verify, in ~1s, before
 * our handler ever ran — no error naming the cause, and the same handler kept
 * working through the credit path. Five services sat unsellable for weeks on
 * this, and shortening the text is what brought each one back. Until the
 * facilitator documents (or lifts) the limit, a long description is a silent
 * outage, so it is worth failing the build over.
 *
 * The limit started as a guess and is now measured, on one resource across
 * seven deploys (x402-foundation/x402#2993). Counts are code points / UTF-16
 * units / bytes:
 *
 *   468 / 469 / 471   settled      508 / 509 / 511   refused
 *   493 / 494 / 496   settled      518 / 519 / 521   refused
 *   498 / 499 / 501   settled      581 / 582 / 584   refused, twice, on two
 *   498 / 518 / 558   settled                        unrelated strings
 *
 * That last row is the one that decides the unit, and it is the reason this file
 * counts code points rather than `length`. It carries 20 non-BMP emoji, so its
 * three counts diverge — and it SETTLED at 518 UTF-16 units and 558 bytes, both
 * of which had already been refused in the rows above. A rule on UTF-16 units
 * would have to refuse 518 and accept 518; a rule on bytes would have to refuse
 * 511 and accept 558. Neither survives. Code points are consistent with every
 * row, so that is what is counted, and the cutoff sits between 499 and 508.
 *
 * Two corollaries worth keeping. It is not about the specific text: two entirely
 * different 582-character strings failed identically. And an emoji costs one,
 * not two — measuring `length` here would reject descriptions the facilitator
 * would happily take.
 *
 * A control rules out the confusion that cost a day the first time round: the
 * same buyer wallet settled a different endpoint in the same minute as each
 * refusal, holding well over the price. The refusals are the facilitator's.
 *
 * Read from source rather than importing SERVICES: the module pulls in
 * server-only handlers, and this check only needs the declared text.
 *
 * The parsing is deliberately paranoid. A first version paired each `id:` with
 * the NEXT `description:` it could find, which silently mismeasured whenever a
 * description was a template literal, a concatenation, a constant, or written
 * above its id — a 600-char description could pass while wearing a neighbour's
 * label. A guard that reports the wrong endpoint, or quietly skips one, is worse
 * than no guard, so this splits into entries first and then refuses to run at
 * all if anything about an entry is not a plain single-line string literal.
 */
const LIMIT = 500;

/**
 * Endpoints deliberately parked over the limit to run an experiment, and the
 * state each must be returned to.
 *
 * Holding a description above the limit on purpose is the only way to measure
 * where the limit is, and this guard would otherwise block exactly that. But an
 * exemption is a liability rather than a convenience: while an id sits here it
 * is unprotected, and an abandoned entry turns a deliberate hole into a
 * permanent one. So each names the issue it serves and the state it reverts to,
 * a second test below fails once an entry stops being used, and the list is
 * expected to be empty.
 */
const EXPERIMENTS: Record<string, string> = {};

interface Declared {
  id: string;
  description: string;
  /** Unicode code points — the unit the facilitator was measured to count, and
   *  the only one consistent with every row in the table above. NOT `length`:
   *  these descriptions open with an emoji, which is one code point but two
   *  UTF-16 units, so `length` overcounts each one and would reject text that
   *  settles fine. */
  codePoints: number;
  /** Bytes on the wire. Reported for context only — a 558-byte description
   *  settled while a 511-byte one was refused, so nothing is capped on bytes. */
  bytes: number;
}

function parseServices(): { declared: Declared[]; unparsable: string[] } {
  const src = readFileSync(new URL("../src/lib/services.ts", import.meta.url), "utf8");
  // Entry boundaries: each service is an object literal opening at this indent.
  // \r is optional throughout: the file is LF in git but a Windows checkout (or
  // any tool that rewrites it) makes it CRLF, and a guard that silently parses
  // ZERO entries on the developer's machine is worse than no guard at all.
  const chunks = src.split(/\r?\n {2}\{\r?\n/).slice(1);
  const declared: Declared[] = [];
  const unparsable: string[] = [];
  for (const chunk of chunks) {
    const body = chunk.split(/\r?\n {2}\},?\r?\n/)[0];
    const id = body.match(/^\s*id:\s*"([\w-]+)",/m)?.[1];
    if (!id) continue; // not a service entry (nested object, params list, …)
    // Skip commented-out entries: they declare nothing at runtime.
    if (/^\s*\/\//.test(body)) continue;
    const desc = body.match(/^\s*description:\s*(?:\/\/[^\n]*\n\s*)*"((?:[^"\\]|\\.)*)",?\s*$/m);
    if (!desc) {
      // A description this parser cannot read is exactly the case that used to
      // slip through. Name it and fail rather than measure the wrong string.
      if (/^\s*description:/m.test(body)) unparsable.push(id);
      continue;
    }
    const description = JSON.parse(`"${desc[1]}"`) as string;
    declared.push({
      id,
      description,
      codePoints: [...description].length,
      bytes: Buffer.byteLength(description, "utf8"),
    });
  }
  return { declared, unparsable };
}

describe("service declarations stay payable", () => {
  it("parses every declaration, or says which one it could not read", () => {
    const { declared, unparsable } = parseServices();
    expect(unparsable, `description not a plain string literal: ${unparsable.join(", ")}`).toEqual([]);
    expect(declared.length).toBeGreaterThan(100);
    // No id may be measured twice, and none of the well-known ones may be missing.
    const ids = declared.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const known of ["safe-check", "domain-check", "email-verify", "token-risk", "url-extract"]) {
      expect(ids, `${known} was not measured`).toContain(known);
    }
  });

  it("keeps every description under the size the facilitator will verify", () => {
    const { declared } = parseServices();
    const tooLong = declared
      .filter((s) => s.codePoints >= LIMIT)
      .filter((s) => !(s.id in EXPERIMENTS))
      .map((s) => `${s.id} (${s.codePoints} code points / ${s.bytes} bytes)`);
    expect(tooLong, `these will silently stop settling on x402: ${tooLong.join(", ")}`).toEqual([]);
  });

  it("counts code points, not UTF-16 units", () => {
    // Regression on the unit itself, because getting it wrong is silent in both
    // directions: `length` would refuse text the facilitator accepts, and there
    // is no build error either way — just descriptions trimmed for no reason, or
    // an endpoint that stops earning. Every description here opens with an emoji,
    // so the two counts genuinely differ and the assertion has teeth.
    const { declared } = parseServices();
    const withAstral = declared.filter((s) => s.codePoints !== s.description.length);
    expect(withAstral.length, "no description contains a non-BMP character, so this test proves nothing").toBeGreaterThan(0);
    for (const s of withAstral) {
      expect(s.codePoints, `${s.id}`).toBeLessThan(s.description.length);
    }
  });

  it("keeps the experiment list honest — every exemption is still being used", () => {
    // An exemption for an id that is already back under the limit is finished
    // business, and leaving it behind turns a deliberate hole into a permanent
    // one. Fail so the entry gets deleted with the revert that earned it.
    const { declared } = parseServices();
    const byId = new Map(declared.map((d) => [d.id, d]));
    const stale: string[] = [];
    for (const [id, why] of Object.entries(EXPERIMENTS)) {
      const s = byId.get(id);
      if (!s) stale.push(`${id} (no longer a service) — ${why}`);
      else if (s.codePoints < LIMIT) stale.push(`${id} (already ${s.codePoints} code points) — ${why}`);
    }
    expect(stale, `remove these from EXPERIMENTS: ${stale.join("; ")}`).toEqual([]);
  });
});
