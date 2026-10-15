import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * An effect written as `useEffect(() => expr)` returns expr to React as its
 * cleanup. /terminal crashed on its first command because Chrome's
 * scrollIntoView now returns a Promise, which React then called as a function.
 * Effects must use a block body.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(f) ? [p] : [];
  });
}

describe("effects", () => {
  it("never return an expression implicitly", () => {
    const bad = files("src").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /use(Layout)?Effect\(\(\) => [^{(]/.test(l))
        .map(({ i }) => `${f}:${i + 1}`),
    );
    expect(bad).toEqual([]);
  });
});
