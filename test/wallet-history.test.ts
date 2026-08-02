import { describe, it, expect } from "vitest";
import { firstBlockWhere } from "../src/lib/wallet-history";

/**
 * `wallet-summary` and `first-funder` both answer "how old is this wallet" by
 * bisecting the Base archive for the first block where the account existed. The
 * whole answer is that one block number, and there is nothing downstream to
 * sanity-check it against — an off-by-one in the bracketing does not throw, it
 * just reports the wrong age, and a wallet dated three months young instead of
 * three days old is exactly the sybil call the endpoint is sold to prevent.
 *
 * So the search gets tested directly, against a synthetic predicate whose answer
 * we already know, across the whole range of shapes it meets in production:
 * the target at either edge, ranges smaller than a single probe round, and
 * ranges the size of Base itself.
 */
describe("archive first-block search", () => {
  /** Monotonic step at `target`, plus a count of how many probes it took. */
  const stepAt = (target: bigint) => {
    let calls = 0;
    return {
      probe: async (b: bigint) => {
        calls++;
        return b >= target;
      },
      get calls() {
        return calls;
      },
    };
  };

  it("finds the step exactly, wherever it sits in a Base-sized range", async () => {
    const hi = 49_438_000n; // roughly Base's head at time of writing
    const targets = [1n, 2n, 7n, 8n, 9n, 1_000n, 29_314_436n, hi - 1n, hi];
    for (const target of targets) {
      const s = stepAt(target);
      expect(await firstBlockWhere(1n, hi, s.probe), `target ${target}`).toBe(target);
    }
  });

  it("finds it in narrow ranges, where the fan degrades to a linear sweep", async () => {
    for (let hi = 1n; hi <= 20n; hi++) {
      for (let target = 1n; target <= hi; target++) {
        const s = stepAt(target);
        expect(await firstBlockWhere(1n, hi, s.probe), `range 1..${hi} target ${target}`).toBe(target);
      }
    }
  });

  it("stays inside the probe budget that keeps the call under its timeout", async () => {
    // ~9 rounds over 49M blocks; each round is one batched request. If a change
    // pushes this into the dozens of rounds the endpoint starts timing out
    // rather than returning a wrong answer, but it still stops earning.
    const s = stepAt(29_314_436n);
    await firstBlockWhere(1n, 49_438_000n, s.probe);
    expect(s.calls).toBeLessThan(80);
  });

  it("returns the upper bound when the predicate never holds", async () => {
    // A caller that ignored this would report the wallet as first seen at the
    // chain head — the search itself cannot tell "never true" from "true at hi",
    // which is why firstAppearance checks the account is non-empty before it
    // ever starts searching.
    expect(await firstBlockWhere(1n, 5_000n, async () => false)).toBe(5_000n);
  });
});
