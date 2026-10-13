import { describe, it, expect } from "vitest";
import { GET, POST, ACTIVE_BOUNTIES } from "../src/app/api/bounties/route";

describe("Autonomous Agent Task Escrow & Bounties API (/api/bounties)", () => {
  it("GET returns active bounties, escrow pool summary, and Base builder code header", async () => {
    const req = new Request("http://localhost:3000/api/bounties");
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toContain("Base Mainnet");
    expect(json.builderCode).toBe("bc_pa0gqlv1");
    expect(json.escrowSummary.totalBounties).toBeGreaterThanOrEqual(4);
    expect(json.escrowSummary.totalRewardPoolUsdc).toBeGreaterThan(0);
    expect(Array.isArray(json.bounties)).toBe(true);

    const first = json.bounties[0];
    expect(first.rewardUsdc).toBeGreaterThan(0);
    expect(first.requiredServiceId).toBeDefined();
  });

  it("POST action='create' deposits funds into micro-escrow and registers task", async () => {
    const req = new Request("http://localhost:3000/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        title: "Test AI Bounty for Rug Scoring",
        category: "FORENSIC_AUDIT",
        rewardUsdc: 1.75,
        requiredServiceId: "rug-score",
        description: "Verify contract dump risk before opening liquidity position",
        creator: "TestAgent-Alpha",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.action).toBe("create");
    expect(json.bounty.title).toBe("Test AI Bounty for Rug Scoring");
    expect(json.bounty.rewardUsdc).toBe(1.75);
    expect(json.escrowDeposit.protocol).toBe("x402 (EIP-3009)");
    expect(json.escrowDeposit.status).toBe("ESCROWED_ONCHAIN");
  });

  it("POST action='claim_and_settle' completes bounty and produces onchain tx & EAS proof", async () => {
    const req = new Request("http://localhost:3000/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "claim_and_settle",
        bountyId: ACTIVE_BOUNTIES[0].id,
        workerAgent: "FADE-Autonomous-Worker",
        executionProof: {
          auditVerdict: "CLEAN_VERIFIED",
          confidencePct: 99.4,
        },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.action).toBe("claim_and_settle");
    expect(json.settlement.txHash).toContain("0x");
    expect(json.settlement.easAttestationUid).toContain("0x");
    expect(json.settlement.basescanUrl).toContain("basescan.org/tx/");
    expect(json.settlement.easExplorerUrl).toContain("base.easscan.org");
  });
});
