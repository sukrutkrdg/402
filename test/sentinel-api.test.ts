import { describe, it, expect } from "vitest";
import { GET } from "../src/app/api/sentinel/alerts/route";

describe("GET /api/sentinel/alerts", () => {
  it("returns active security alerts with formatted viral broadcast payloads", async () => {
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("SENTINEL_ACTIVE");
    expect(data.builderCode).toBe("bc_pa0gqlv1");
    expect(data.alerts.length).toBeGreaterThan(0);

    const first = data.alerts[0];
    expect(first.type).toBe("HONEYPOT_DETECTED");
    expect(first.broadcastPayload.farcasterCast).toContain("🚨");
    expect(first.broadcastPayload.xTweet).toContain("@CoinbaseDev");
    expect(first.verifiedReceiptUrl).toContain("402.com.tr");
  });
});
