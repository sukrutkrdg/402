import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/publish/route";
import { NextRequest } from "next/server";

describe("Publisher Protocol /api/publish", () => {
  it("GET returns publisher terms and 90/10 revenue share", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.terms.revenueShare.publisher).toBe("90%");
    expect(data.terms.revenueShare.platformFee).toBe("10%");
  });

  it("POST validates input parameters", async () => {
    const req = new NextRequest("http://localhost/api/publish", {
      method: "POST",
      body: JSON.stringify({ name: "hi" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST successfully registers a valid publisher API", async () => {
    const req = new NextRequest("http://localhost/api/publish", {
      method: "POST",
      body: JSON.stringify({
        name: "Autonomous Sentiment Oracle",
        description: "Evaluates token sentiment across social channels",
        targetUrl: "https://api.example.com/v1/sentiment",
        priceUsdc: "0.03",
        payoutAddress: "0x50ec051c512da5047b41e8c78c2e6ba804be8505",
        category: "AI",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.service.id).toBe("pub-autonomous-sentiment-oracle");
    expect(data.service.price).toBe("$0.03");
    expect(data.service.revenueShare.publisher).toBe("90%");
  });
});
