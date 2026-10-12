import { getSiteUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const title = url.searchParams.get("title") || "x402 Bazaar — Pay-Per-Call AI Agent Marketplace";
  const subtitle = url.searchParams.get("subtitle") || "Autonomous EIP-3009 Settlement on Base";
  const serviceId = url.searchParams.get("service") || "clanker-token-audit";
  const builderCode = "bc_pa0gqlv1";

  const siteUrl = getSiteUrl();
  const imageUrl = `${siteUrl}/api/frames/card?title=${encodeURIComponent(title)}&subtitle=${encodeURIComponent(subtitle)}&builder=${builderCode}`;
  const targetUrl = `${siteUrl}/playground?service=${encodeURIComponent(serviceId)}`;

  // Farcaster Frame v2 / Mini-App manifest data
  const frameMetadata = {
    version: "next",
    imageUrl,
    button: {
      title: "⚡ Open in x402 Bazaar",
      action: {
        type: "launch_frame",
        name: "x402 Bazaar",
        url: targetUrl,
        splashImageUrl: `${siteUrl}/brand/splash`,
        splashBackgroundColor: "#07080a",
      },
    },
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} | x402 Bazaar</title>
  
  <!-- OpenGraph Metadata -->
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${subtitle} — Zero gas AI agent micropayments on Base." />
  <meta property="og:image" content="${imageUrl}" />
  <meta property="og:url" content="${targetUrl}" />
  <meta property="og:type" content="website" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${subtitle}" />
  <meta name="twitter:image" content="${imageUrl}" />

  <!-- Farcaster Frame v2 Specification -->
  <meta name="fc:frame" content='${JSON.stringify(frameMetadata)}' />
  <meta name="fc:frame:image" content="${imageUrl}" />
  <meta name="fc:frame:button:1" content="⚡ Launch x402 Miniapp" />
  <meta name="fc:frame:button:1:action" content="link" />
  <meta name="fc:frame:button:1:target" content="${targetUrl}" />

  <style>
    body {
      margin: 0;
      padding: 0;
      background: #04060d;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
    }
    .card {
      max-width: 520px;
      padding: 2.5rem;
      border-radius: 20px;
      background: #090e24;
      border: 1px solid rgba(0, 82, 255, 0.4);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; font-weight: 800; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .btn {
      display: inline-block;
      padding: 0.85rem 1.75rem;
      border-radius: 12px;
      background: #0052ff;
      color: #ffffff;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.95rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #0043d4; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 2.5rem; margin-bottom: 1rem;">🤖</div>
    <h1>${title}</h1>
    <p>${subtitle}<br />Facilitated on Base with Builder Code <code style="color: #60a5fa;">${builderCode}</code>.</p>
    <a href="${targetUrl}" class="btn">Launch in x402 Bazaar ↗</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "x-builder-code": builderCode,
    },
  });
}
