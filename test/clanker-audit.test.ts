import { describe, expect, it } from "vitest";
import { clankerTokenAudit, CLANKER_V4_DEPLOYER, CLANKER_V3_DEPLOYER } from "@/lib/clanker-audit";

describe("clanker-token-audit", () => {
  it("rejects invalid addresses", async () => {
    await expect(clankerTokenAudit({ address: "invalid" })).rejects.toThrow(
      "Provide a valid 0x… Base token address"
    );
  });

  it("rejects an address without token bytecode", async () => {
    const eoa = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    await expect(clankerTokenAudit({ address: eoa })).rejects.toThrow(
      "Target address is an EOA wallet or not a valid ERC-20 token contract"
    );
  });

  it("audits a standard Base token (e.g. DEGEN) accurately", async () => {
    const degen = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    const res = await clankerTokenAudit({ address: degen });

    expect(res).toBeDefined();
    expect(res.address).toBe(degen.toLowerCase());
    expect(["AUTHENTIC_CLANKER", "STANDARD_TOKEN", "IMPERSONATOR_RISK"]).toContain(res.verdict);
    expect(res.data).toBeDefined();
    expect(res.data.name).toBeDefined();
    expect(res.data.symbol).toBeDefined();
    expect(res.receipt).toBeDefined();
  });
});
