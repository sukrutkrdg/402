import { describe, it, expect } from "vitest";
import { POST } from "../src/app/api/simulate/eip3009/route";

describe("EIP-3009 Simulation API (/api/simulate/eip3009)", () => {
  it("executes simulated micropayment and returns complete EIP-712 payload", async () => {
    const req = new Request("http://localhost:3000/api/simulate/eip3009", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serviceId: "clanker-token-audit",
        amountUsdc: 0.10,
        buyerAddress: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
        startingBalance: 10.0,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");
    expect(res.headers.get("x-eip3009-simulated")).toBe("true");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.serviceId).toBe("clanker-token-audit");

    // EIP-712 domain & typed data checks
    expect(json.eip712.domain.chainId).toBe(8453);
    expect(json.eip712.domain.name).toBe("USD Coin");
    expect(json.eip712.primaryType).toBe("TransferWithAuthorization");
    expect(json.eip712.message.from).toBe("0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7");
    expect(json.eip712.signature.v).toBe(27);
    expect(json.eip712.signature.r.startsWith("0x")).toBe(true);
    expect(json.eip712.signature.s.startsWith("0x")).toBe(true);

    // Financial split (90% publisher / 10% platform)
    expect(json.settlement.totalAmountUsdc).toBe(0.10);
    expect(json.settlement.publisherPayoutUsdc).toBe(0.09);
    expect(json.settlement.platformFeeUsdc).toBe(0.01);
    expect(json.settlement.gasSponsoredByFacilitator).toBe(true);
    expect(json.settlement.builderCode).toBe("bc_pa0gqlv1");

    // Buyer mock balance
    expect(json.buyerAgent.remainingMockBalanceUsdc).toBe(9.9);
  });

  it("handles empty payload gracefully with default values", async () => {
    const req = new Request("http://localhost:3000/api/simulate/eip3009", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.settlement.totalAmountUsdc).toBe(0.05);
    expect(json.settlement.publisherPayoutUsdc).toBe(0.045);
  });
});
