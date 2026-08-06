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
 * The limit started as a guess and is now measured, on one resource in one
 * afternoon (x402-foundation/x402#2993):
 *
 *   469 chars / 471 B  settled      509 / 511  refused
 *   494 / 496          settled      519 / 521  refused
 *   499 / 501          settled      582 / 584  refused, twice, on two
 *                                              unrelated strings
 *
 * Three things fall out. It counts CHARACTERS, not bytes — 501 bytes settled
 * while 509 characters did not. It is not about the specific text: two entirely
 * different 582-character strings failed identically. And 500 is the right
 * place to draw the line, since 499 settles and everything from 509 up does
 * not; the exact cutoff between 500 and 508 is untested and not worth the
 * deploys to find.
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
 * commit that must revert them.
 *
 * The limit above is a guess about the facilitator's behaviour, and the guess is
 * now known to be wrong in general — another seller measured 90 indexed
 * resources at 517+ characters, 89 of which took paid calls in the last 30 days.
 * What is NOT explained is why five of ours became unpayable and recovered the
 * moment their text changed. Settling that needs one endpoint held above the
 * limit on purpose, which is exactly what this guard would otherwise block.
 *
 * An exemption here is a liability, not a convenience: while an id sits in this
 * list it is unprotected, and if the experiment is abandoned the entry silently
 * becomes a permanent hole. So each one names the issue it serves and the state
 * it must be returned to, and the list is expected to be empty.
 */
const EXPERIMENTS: Record<string, string> = {
  // x402-foundation/x402#2993 step 6: 498 code points / 518 UTF-16 units / 558
  // bytes, to find which of the three the facilitator actually counts. Nobody
  // else in the index can run this — of the 70 settling resources at 517+
  // characters, not one contains a surrogate pair, so for all of them the units
  // coincide. Revert to the 494-character description once the result is read.
  "paymaster-check": "restore to the 494-char description once #2993 step 6 is read",
};

interface Declared {
  id: string;
  description: string;
  /** Bytes on the wire — the declaration is serialised as UTF-8, and these
   *  descriptions are full of emoji and em-dashes that cost 3-4 bytes each. */
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
    declared.push({ id, description, bytes: Buffer.byteLength(description, "utf8") });
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
    // Measured both ways: characters are what we type, bytes are what is sent,
    // and emoji make those differ by dozens. Fail on whichever is larger.
    const tooLong = declared
      .filter((s) => Math.max(s.description.length, s.bytes) >= LIMIT)
      .filter((s) => !(s.id in EXPERIMENTS))
      .map((s) => `${s.id} (${s.description.length} chars / ${s.bytes} bytes)`);
    expect(tooLong, `these will silently stop settling on x402: ${tooLong.join(", ")}`).toEqual([]);
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
      else if (Math.max(s.description.length, s.bytes) < LIMIT) stale.push(`${id} (already ${s.description.length} chars) — ${why}`);
    }
    expect(stale, `remove these from EXPERIMENTS: ${stale.join("; ")}`).toEqual([]);
  });
});
