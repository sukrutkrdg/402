import { describe, it, expect } from "vitest";
import { GET as getCard } from "../src/app/api/frames/card/route";
import { GET as getShare } from "../src/app/api/frames/share/route";

describe("Farcaster Frames v2 & Dynamic Share API", () => {
  it("renders dynamic SVG image card with correct MIME type and builder code", async () => {
    const req = new Request("http://localhost:3000/api/frames/card?title=Token+Audit&subtitle=Safe+0x123&builder=bc_pa0gqlv1&price=$0.10+USDC");
    const res = await getCard(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const svg = await res.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("Token Audit");
    expect(svg).toContain("Safe 0x123");
    expect(svg).toContain("bc_pa0gqlv1");
    expect(svg).toContain("$0.10 USDC");
    expect(svg).toContain("x402 BAZAAR");
  });

  it("serves Frame v2 interactive HTML with OpenGraph and fc:frame meta tags", async () => {
    const req = new Request("http://localhost:3000/api/frames/share?title=Agent+Micropayment&service=clanker-token-audit");
    const res = await getShare(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("x-builder-code")).toBe("bc_pa0gqlv1");

    const html = await res.text();
    expect(html).toContain('property="og:title"');
    expect(html).toContain('name="fc:frame"');
    expect(html).toContain("launch_frame");
    expect(html).toContain("x402 Bazaar");
    expect(html).toContain("bc_pa0gqlv1");
  });
});
