export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const title = url.searchParams.get("title") || "x402 Bazaar — Autonomous Agent Marketplace";
  const subtitle = url.searchParams.get("subtitle") || "Pay-Per-Call AI & DeFi APIs on Base";
  const badge = url.searchParams.get("badge") || "EIP-3009 ACTIVE";
  const builder = url.searchParams.get("builder") || "bc_pa0gqlv1";
  const price = url.searchParams.get("price") || "$0.05 USDC";
  const latency = url.searchParams.get("latency") || "18ms";

  // Sanitize strings for XML SVG inclusion
  const cleanTitle = title.replace(/[<>&"]/g, "");
  const cleanSubtitle = subtitle.replace(/[<>&"]/g, "");
  const cleanBadge = badge.replace(/[<>&"]/g, "");
  const cleanBuilder = builder.replace(/[<>&"]/g, "");
  const cleanPrice = price.replace(/[<>&"]/g, "");
  const cleanLatency = latency.replace(/[<>&"]/g, "");

  const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#04060d" />
      <stop offset="50%" stop-color="#090e24" />
      <stop offset="100%" stop-color="#020307" />
    </linearGradient>
    <linearGradient id="blueGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#0052ff" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>
    <linearGradient id="borderGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(0, 82, 255, 0.6)" />
      <stop offset="100%" stop-color="rgba(56, 189, 248, 0.2)" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)" />

  <!-- Grid Pattern Overlay -->
  <g opacity="0.1" stroke="#38bdf8" stroke-width="1">
    <line x1="0" y1="105" x2="1200" y2="105" />
    <line x1="0" y1="210" x2="1200" y2="210" />
    <line x1="0" y1="315" x2="1200" y2="315" />
    <line x1="0" y1="420" x2="1200" y2="420" />
    <line x1="0" y1="525" x2="1200" y2="525" />
    <line x1="200" y1="0" x2="200" y2="630" />
    <line x1="400" y1="0" x2="400" y2="630" />
    <line x1="600" y1="0" x2="600" y2="630" />
    <line x1="800" y1="0" x2="800" y2="630" />
    <line x1="1000" y1="0" x2="1000" y2="630" />
  </g>

  <!-- Card Container Frame -->
  <rect x="50" y="50" width="1100" height="530" rx="28" fill="#080c18" fill-opacity="0.85" stroke="url(#borderGlow)" stroke-width="2" />

  <!-- Top Bar -->
  <g transform="translate(100, 110)">
    <!-- Brand Logo Circle -->
    <circle cx="28" cy="28" r="28" fill="#0052ff" />
    <text x="28" y="36" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="900" fill="#ffffff" text-anchor="middle">402</text>
    
    <text x="75" y="24" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="800" fill="#ffffff" letter-spacing="0.5">x402 BAZAAR</text>
    <text x="75" y="44" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="500" fill="#64748b">AI AGENT MARKETPLACE ON BASE</text>

    <!-- Top Badges -->
    <g transform="translate(620, 8)">
      <!-- EIP Badge -->
      <rect x="0" y="0" width="160" height="38" rx="10" fill="rgba(16, 185, 129, 0.12)" stroke="rgba(16, 185, 129, 0.3)" />
      <circle cx="20" cy="19" r="5" fill="#10b981" />
      <text x="34" y="24" font-family="monospace" font-size="13" font-weight="700" fill="#34d399">${cleanBadge}</text>

      <!-- Builder Badge -->
      <rect x="175" y="0" width="165" height="38" rx="10" fill="rgba(0, 82, 255, 0.15)" stroke="rgba(0, 82, 255, 0.4)" />
      <text x="190" y="24" font-family="monospace" font-size="13" font-weight="700" fill="#60a5fa">${cleanBuilder}</text>
    </g>
  </g>

  <!-- Center Card Content -->
  <g transform="translate(100, 240)">
    <text x="0" y="0" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="900" fill="#ffffff" letter-spacing="-0.5">
      ${cleanTitle}
    </text>
    <text x="0" y="45" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="400" fill="#94a3b8">
      ${cleanSubtitle}
    </text>
  </g>

  <!-- Bottom Metric Pills -->
  <g transform="translate(100, 420)">
    <!-- Pill 1: Price -->
    <rect x="0" y="0" width="220" height="90" rx="18" fill="#0c1122" stroke="rgba(255,255,255,0.08)" />
    <text x="24" y="34" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="600" fill="#64748b" text-transform="uppercase">COST PER CALL</text>
    <text x="24" y="66" font-family="monospace" font-size="24" font-weight="800" fill="#38bdf8">${cleanPrice}</text>

    <!-- Pill 2: Revenue Share -->
    <rect x="240" y="0" width="230" height="90" rx="18" fill="#0c1122" stroke="rgba(16, 185, 129, 0.2)" />
    <text x="264" y="34" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="600" fill="#10b981" text-transform="uppercase">PUBLISHER SPLIT</text>
    <text x="264" y="66" font-family="monospace" font-size="24" font-weight="800" fill="#34d399">90% USDC</text>

    <!-- Pill 3: Latency -->
    <rect x="490" y="0" width="220" height="90" rx="18" fill="#0c1122" stroke="rgba(255,255,255,0.08)" />
    <text x="514" y="34" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="600" fill="#64748b" text-transform="uppercase">AUTH LATENCY</text>
    <text x="514" y="66" font-family="monospace" font-size="24" font-weight="800" fill="#f8fafc">${cleanLatency}</text>

    <!-- Pill 4: Gas Sponsorship -->
    <rect x="730" y="0" width="270" height="90" rx="18" fill="#0c1122" stroke="rgba(0, 82, 255, 0.3)" />
    <text x="754" y="34" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="600" fill="#60a5fa" text-transform="uppercase">AGENT GAS SPONSORSHIP</text>
    <text x="754" y="66" font-family="monospace" font-size="24" font-weight="800" fill="#ffffff">0 Gwei (Free)</text>
  </g>
</svg>`;

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "x-builder-code": cleanBuilder,
    },
  });
}
