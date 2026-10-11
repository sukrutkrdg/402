import { describe, it, expect, vi } from "vitest";
import { agentProvenance } from "@/lib/agent-provenance";

// Mock Viem client methods
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === "0x1111111111111111111111111111111111111111") {
          // EIP-7702 delegation bytecode
          return "0xef01002222222222222222222222222222222222222222";
        }
        if (address.toLowerCase() === "0x3333333333333333333333333333333333333333") {
          // Standard contract
          return "0x6080604052348015";
        }
        return undefined; // EOA
      },
      getTransactionCount: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === "0x4444444444444444444444444444444444444444") return 150;
        return 0;
      },
    }),
  };
});

describe("agent-provenance", () => {
  it("detects EIP-7702 delegated autonomous agents", async () => {
    const res = await agentProvenance({ address: "0x1111111111111111111111111111111111111111" });
    expect(res.isAgent).toBe(true);
    expect(res.framework).toBe("eip7702");
    expect(res.delegatedTo?.toLowerCase()).toBe("0x2222222222222222222222222222222222222222");
    expect(res.verdict).toBe("delegated_agent");
  });

  it("classifies active human EOAs with established transaction counts", async () => {
    const res = await agentProvenance({ address: "0x4444444444444444444444444444444444444444" });
    expect(res.isAgent).toBe(false);
    expect(res.framework).toBe("standard_eoa");
    expect(res.txCount).toBe(150);
    expect(res.verdict).toBe("active_account");
  });

  it("flags empty fresh addresses as high caution", async () => {
    const res = await agentProvenance({ address: "0x5555555555555555555555555555555555555555" });
    expect(res.verdict).toBe("fresh_account");
    expect(res.agentSafetyScore).toBeLessThan(50);
  });

  it("rejects non-hex invalid addresses", async () => {
    await expect(agentProvenance({ address: "invalid-not-an-address" })).rejects.toThrow(/must be a valid 0x 20-byte address/);
  });
});
