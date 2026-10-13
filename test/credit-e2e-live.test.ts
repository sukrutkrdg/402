import { describe, it, expect } from "vitest";
import { GET, POST } from "../src/app/api/credit/line/route";
import { GET as getBalance } from "../src/app/api/credits/balance/route";

describe("Live End-to-End Agent Credit Line Integration", () => {
  it("runs the full autonomous credit lifecycle: Score -> Borrow -> Token Verification -> Repay", async () => {
    const agentWallet = "0xec2abd3eda89bed90124736e317e847d5fb6d034";

    // 1. Check Profile
    const getReq = new Request(`http://localhost:3000/api/credit/line?wallet=${agentWallet}`);
    const getRes = await GET(getReq as any);
    expect(getRes.status).toBe(200);
    const profileData = await getRes.json();
    expect(profileData.profile.creditScore).toBeGreaterThanOrEqual(750);
    expect(profileData.profile.rating).toBe("VERIFIED");
    const initialScore = profileData.profile.creditScore;

    // 2. Borrow $2.00
    const borrowReq = new Request("http://localhost:3000/api/credit/line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "borrow",
        wallet: agentWallet,
        amountUsdc: 2.0,
      }),
    });
    const borrowRes = await POST(borrowReq);
    expect(borrowRes.status).toBe(200);
    const borrowData = await borrowRes.json();
    expect(borrowData.success).toBe(true);
    expect(borrowData.creditToken).toMatch(/^ck_[0-9a-f]{36}$/);
    expect(borrowData.loanReceipt.principalUsdc).toBe(2.0);
    expect(borrowData.loanReceipt.totalDueUsdc).toBeGreaterThanOrEqual(2.0);

    // 3. Verify Token
    const creditToken = borrowData.creditToken;
    expect(creditToken).toBeDefined();

    // 4. Repay & Boost
    const repayReq = new Request("http://localhost:3000/api/credit/line", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "repay",
        wallet: agentWallet,
        repayAmountUsdc: borrowData.loanReceipt.totalDueUsdc,
      }),
    });
    const repayRes = await POST(repayReq);
    expect(repayRes.status).toBe(200);
    const repayData = await repayRes.json();
    expect(repayData.success).toBe(true);
    expect(repayData.creditScoreDelta).toBe("+20 points");
    expect(repayData.updatedProfile.creditScore).toBe(initialScore + 20);
    expect(repayData.updatedProfile.outstandingDebtUsdc).toBe(0);
  });
});
