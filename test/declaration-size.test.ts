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
      .map((s) => `${s.id} (${s.description.length} chars / ${s.bytes} bytes)`);
    expect(tooLong, `these will silently stop settling on x402: ${tooLong.join(", ")}`).toEqual([]);
  });
});
