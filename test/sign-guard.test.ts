/**
 * sign-guard 1.1: a revoke is never held over the destination's powers, and an
 * upgradeable proxy on an established token (USDC) is context, not a HOLD.
 * Found on our own paid sweep (2026-10-17): approve(spender, 0) on USDC — an
 * agent cleaning up — answered HOLD for "critical owner powers (upgrade)".
 */

import { describe, it, expect, vi } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";

const state = vi.hoisted(() => ({
  danger: { verified: true, dangerLevel: "critical", dangerCategories: ["upgrade"] } as Record<string, unknown>,
  established: true,
}));

vi.mock("@/lib/contract-danger", () => ({ contractDanger: async () => state.danger }));
vi.mock("@/lib/compliance", () => ({ sanctionsCheck: async () => ({ sanctioned: false }) }));
vi.mock("@/lib/upstream-cache", () => ({ goPlusSecurity: async () => ({ holder_count: "11000000" }) }));
vi.mock("@/lib/established", () => ({
  establishedContext: async () => ({ established: state.established, basis: state.established ? "established: test" : "not established: test" }),
}));

const { signGuard } = await import("@/lib/sign-guard");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SPENDER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const abi = parseAbi(["function approve(address,uint256)"]);
const approve = (n: bigint) => encodeFunctionData({ abi, functionName: "approve", args: [SPENDER, n] });

describe("sign-guard calibration", () => {
  it("a revoke (approve 0) is GO even on a destination with critical powers", async () => {
    state.established = false;
    const r = await signGuard({ data: approve(0n), to: USDC });
    expect(r.decision).toBe("GO");
    expect(r.checks.revoke).toBe(true);
    state.established = true;
  });

  it("a scoped approve on an established upgradeable token is GO, the proxy reported as context", async () => {
    const r = await signGuard({ data: approve(1_000_000n), to: USDC });
    expect(r.decision).toBe("GO");
    expect(r.checks.destinationContext).toEqual(["upgrade"]);
  });

  it("the same approve on a non-established upgradeable token still holds", async () => {
    state.established = false;
    const r = await signGuard({ data: approve(1_000_000n), to: USDC });
    expect(r.decision).toBe("HOLD");
    state.established = true;
  });

  it("an unlimited approve is never cleared by the established rule", async () => {
    const r = await signGuard({ data: approve(2n ** 256n - 1n), to: USDC });
    expect(r.decision).not.toBe("GO");
  });

  it("a blacklist power is never demoted, established or not", async () => {
    state.danger = { verified: true, dangerLevel: "critical", dangerCategories: ["upgrade", "blacklist"] };
    const r = await signGuard({ data: approve(1_000_000n), to: USDC });
    expect(r.decision).toBe("HOLD");
  });
});
