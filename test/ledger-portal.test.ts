/**
 * Base Ledgers Portal check — a PROTOTYPE until Base publishes the Portal spec.
 * The chain read is in the handler; what matters to pin is the verdict logic,
 * especially that an unreadable address is "unknown", never "no contract".
 */

import { describe, it, expect } from "vitest";
import { portalVerdict } from "@/lib/ledger-portal";

describe("ledger portal verdict", () => {
  it("an unreadable chain (null) is unknown, never no_contract", () => {
    expect(portalVerdict(null, false)).toBe("unknown");
    expect(portalVerdict(null, true)).toBe("unknown");
  });

  it("no bytecode means it cannot be a Portal", () => {
    expect(portalVerdict(false, false)).toBe("no_contract");
    expect(portalVerdict(false, true)).toBe("no_contract");
  });

  it("a deployed contract without the published spec is pending, not readable", () => {
    expect(portalVerdict(true, false)).toBe("contract_spec_pending");
  });

  it("a deployed contract with the spec configured is readable", () => {
    expect(portalVerdict(true, true)).toBe("portal_readable");
  });
});
