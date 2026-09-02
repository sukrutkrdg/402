/**
 * Cobalt's seize surface, and the one thing about it that is easy to get wrong.
 *
 * `seizeWithMemo` reads SEIZE_HOLDER_POLICY against the holder, and the spec
 * defines `AccountNotSeizable(address)` as thrown "when `from` IS AUTHORIZED
 * under SEIZE_HOLDER_POLICY (that is, not seizable)". So authorized means
 * PROTECTED here — the reverse of TRANSFER_SENDER_POLICY, where authorized
 * means allowed. Implementing it from intuition inverts the verdict and tells a
 * seizable holder it is safe, which is the failure this file exists to prevent.
 */

import { describe, it, expect } from "vitest";
import { seizeStatusFrom } from "@/lib/b20-safety";

describe("B20 Cobalt seize semantics", () => {
  it("treats an unset policy as nobody-seizable, not everybody-seizable", () => {
    // Always-allow: every holder is authorized, so no seize can succeed.
    expect(seizeStatusFrom(0n, null)).toBe("none");
    expect(seizeStatusFrom(0n, true)).toBe("none");
    expect(seizeStatusFrom(0n, false)).toBe("none");
  });

  it("treats a missing policy scope (pre-Cobalt revert) as no seize surface", () => {
    expect(seizeStatusFrom(null, null)).toBe("none");
  });

  it("INVERTS authorization: authorized means protected", () => {
    expect(seizeStatusFrom(7n, true)).toBe("protected");
  });

  it("INVERTS authorization: not authorized means seizable", () => {
    expect(seizeStatusFrom(7n, false)).toBe("seizable");
  });

  it("never reports an unreadable registry as clear", () => {
    // An armed policy we could not evaluate is unknown. Falling back to
    // "protected" would hand a seizable holder an all-clear.
    expect(seizeStatusFrom(7n, null)).toBe("unknown");
  });
});
