import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression for the bug where aiContractRisk read `abiData.abi` (which never
// exists) instead of `abiData.functions`, so Claude got zero function names.
const { createMock, tokenRiskMock, contractAbiMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  tokenRiskMock: vi.fn(),
  contractAbiMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));
vi.mock("@/lib/onchain", () => ({ tokenRisk: tokenRiskMock }));
vi.mock("@/lib/onchain-extra3", () => ({ contractAbi: contractAbiMock }));

import { aiContractRisk } from "@/lib/ai-report";

const CONTRACT = "0x4444444444444444444444444444444444444444";

describe("aiContractRisk — passes ABI function names to Claude", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    tokenRiskMock.mockResolvedValue({ flags: ["mintable"], security: { isMintable: true } });
    contractAbiMock.mockResolvedValue({
      verified: true,
      matchType: "full",
      functions: ["mint", "blacklist", "setFee"],
      events: [],
      abiItemCount: 3,
    });
    createMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            dangerLevel: "dangerous",
            verified: true,
            summary: "Owner can mint and blacklist.",
            dangerousCapabilities: [],
            observations: [],
          }),
        },
      ],
    });
  });

  it("includes the contract's function names in the message sent to Claude", async () => {
    await aiContractRisk({ address: CONTRACT });
    expect(createMock).toHaveBeenCalledOnce();
    const payload = createMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userContent = payload.messages[0].content;
    expect(userContent).toContain("mint");
    expect(userContent).toContain("blacklist");
    expect(userContent).toContain("setFee");
    // and the verified flag is derived from `verified`, not `matchType`
    expect(userContent).toContain('"verified":true');
  });
});
