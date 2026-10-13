import { describe, it, expect } from "vitest";
import { GET, POST, evaluateWalletCredit } from "../src/app/api/credit/line/route";

describe("Autonomous Agent Credit Line & Flash Liquidity API (/api/credit/line)", () => {
  it("GET returns evaluated credit profile and Base builder code header", async () => {
    const req = new Request("http://localhost:3000/api/credit/line?wallet=0x7a250d5630b4cf539739df2c5dacb4c659f2488d");
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toContain("Base Mainnet");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.profile.creditScore).toBeGreaterThanOrEqual(800);
    expect(json.profile.rating).toBe("PRIME");
    expect(json.profile.maxCreditLimitUsdc).toBe(50.0);
    expect(Array.isArray(json.leaderboard)).toBe(true);
  });

  it("evaluates today's live buyer wallet with verified rating and limit", () => {
    const buyerProfile = evaluateWalletCredit("0xec2abd3eda89bed90124736e317e847d5fb6d034");
    expect(buyerProfile.creditScore).toBeGreaterThanOrEqual(750);
    expect(buyerProfile.maxCreditLimitUsdc).toBeGreaterThanOrEqual(25.0);
    expect(buyerProfile.onchainTxCount).toBe(103);
  });

  it("POST action='borrow' issues flash credit loan and updates available credit", async () => {
    const req = new Request("http://localhost:3000/api/credit/line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "borrow",
        wallet: "0xec2abd3eda89bed90124736e317e847d5fb6d034",
        amountUsdc: 5.0,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.action).toBe("borrow");
    expect(json.loanReceipt.principalUsdc).toBe(5.0);
    expect(json.loanReceipt.basescanUrl).toContain("basescan.org/tx/");
    expect(json.loanReceipt.creditToken).toMatch(/^ck_[0-9a-f]{36}$/);
    expect(json.liquidityDisbursed.creditToken).toBe(json.loanReceipt.creditToken);
    expect(json.liquidityDisbursed.protocol).toContain("EIP-3009");
  });

  it("POST action='repay' clears debt and rewards credit score increase", async () => {
    const req = new Request("http://localhost:3000/api/credit/line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "repay",
        wallet: "0xec2abd3eda89bed90124736e317e847d5fb6d034",
        repayAmountUsdc: 5.025,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.action).toBe("repay");
    expect(json.creditScoreDelta).toBe("+20 points");
    expect(json.easRepaymentReceipt.settledTxHash).toContain("0x");
  });
});
