import { describe, expect, it } from "vitest";
import { farcasterSocialVelocity } from "@/lib/farcaster-velocity";

describe("farcaster-social-velocity", () => {
  it("rejects empty or very short queries", async () => {
    await expect(farcasterSocialVelocity({ query: "a" })).rejects.toThrow(
      "Provide a search query or token ticker"
    );
  });

  it("queries Farcaster velocity for HIGHER or DEGEN", async () => {
    const res = await farcasterSocialVelocity({ query: "HIGHER" });

    expect(res).toBeDefined();
    expect(res.query).toBe("HIGHER");
    expect(["ORGANIC_VIRAL", "HEALTHY_TRACTION", "ASTROTURFED_BOT_SPAM", "LOW_ACTIVITY"]).toContain(res.verdict);
    expect(res.socialMomentumScore).toBeGreaterThanOrEqual(0);
    expect(res.socialMomentumScore).toBeLessThanOrEqual(100);
    expect(typeof res.velocityPerHour).toBe("number");
    expect(res.data).toBeDefined();
    expect(res.receipt).toBeDefined();
  });
});
