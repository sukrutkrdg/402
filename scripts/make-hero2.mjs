// Second tweet hero — a dark "live call" card showing a REAL x402 result
// (dump-risk on DEGEN, from an actual paid settlement). Demonstrates the product
// working + its differentiation. Base-blue accents on dark; sharp SVG → PNG.
import sharp from "sharp";

const W = 1600, H = 900;
const BASE = "#3C7DFF", BASE_SOFT = "#7FA8FF";
const BG0 = "#070B18", BG1 = "#0E1630";
const CARD = "#111A33", LINE = "#243354";
const MUTE = "#8A9AC0", KEY = "#8FB6FF", STR = "#5BD6B0", NUM = "#F2B35B", RED = "#FF6B6B";
const mono = "Consolas, 'DejaVu Sans Mono', monospace";
const sans = "Segoe UI, Arial, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BG0}"/><stop offset="1" stop-color="${BG1}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.1" r="0.7">
      <stop offset="0" stop-color="${BASE}" stop-opacity="0.22"/><stop offset="1" stop-color="${BASE}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- top brand row -->
  <circle cx="78" cy="78" r="26" fill="#ffffff"/>
  <text x="78" y="88" text-anchor="middle" font-family="${sans}" font-size="28" font-weight="800" fill="${BG0}">4</text>
  <text x="120" y="88" font-family="${sans}" font-size="34" font-weight="800" fill="#ffffff">x402 Bazaar</text>
  <text x="120" y="118" font-family="${sans}" font-size="21" font-weight="500" fill="${MUTE}">216 pay-per-call APIs for AI agents · on Base</text>

  <g>
    <rect x="1300" y="52" width="230" height="52" rx="26" fill="#ffffff" fill-opacity="0.08" stroke="${LINE}"/>
    <circle cx="1332" cy="78" r="14" fill="#ffffff"/>
    <text x="1356" y="86" font-family="${sans}" font-size="23" font-weight="700" fill="#ffffff">Built on Base</text>
  </g>

  <!-- terminal card -->
  <rect x="78" y="168" width="1444" height="590" rx="22" fill="${CARD}" stroke="${LINE}" stroke-width="1.5"/>
  <line x1="78" y1="230" x2="1522" y2="230" stroke="${LINE}"/>
  <circle cx="116" cy="199" r="8" fill="#ff5f57"/><circle cx="146" cy="199" r="8" fill="#febc2e"/><circle cx="176" cy="199" r="8" fill="#28c840"/>
  <text x="210" y="206" font-family="${mono}" font-size="20" fill="${MUTE}">agent → x402 Bazaar · live call</text>

  <!-- request -->
  <text x="116" y="286" font-family="${mono}" font-size="20" fill="${MUTE}">REQUEST</text>
  <text x="116" y="326" font-family="${mono}" font-size="26" fill="#DCE6FF">GET /api/x402/<tspan fill="${BASE_SOFT}" font-weight="700">dump-risk</tspan>?address=0x4ed4…Efefed</text>
  <text x="116" y="366" font-family="${mono}" font-size="22" fill="${MUTE}">402 Payment Required → pay <tspan fill="${STR}">$0.04 USDC</tspan> → settle on Base <tspan fill="${STR}">✓</tspan></text>

  <!-- response -->
  <text x="116" y="430" font-family="${mono}" font-size="20" fill="${MUTE}">RESPONSE</text>
  <text x="116" y="470" font-family="${mono}" font-size="25" fill="#C9D4F0">{</text>
  <text x="150" y="506" font-family="${mono}" font-size="25"><tspan fill="${KEY}">"verdict"</tspan><tspan fill="#C9D4F0">: </tspan><tspan fill="${RED}" font-weight="700">"exit_trap"</tspan><tspan fill="#C9D4F0">,</tspan></text>
  <text x="150" y="542" font-family="${mono}" font-size="25"><tspan fill="${KEY}">"topHolderPctOfSupply"</tspan><tspan fill="#C9D4F0">: </tspan><tspan fill="${NUM}">22.61</tspan><tspan fill="#C9D4F0">,</tspan></text>
  <text x="150" y="578" font-family="${mono}" font-size="25"><tspan fill="${KEY}">"topHolderBagUsd"</tspan><tspan fill="#C9D4F0">: </tspan><tspan fill="${NUM}">7_991_046</tspan><tspan fill="#C9D4F0">,</tspan></text>
  <text x="150" y="614" font-family="${mono}" font-size="25"><tspan fill="${KEY}">"aggregateLiquidityUsd"</tspan><tspan fill="#C9D4F0">: </tspan><tspan fill="${NUM}">975_676</tspan><tspan fill="#C9D4F0">,</tspan></text>
  <text x="150" y="650" font-family="${mono}" font-size="25"><tspan fill="${KEY}">"dumpImpactPct"</tspan><tspan fill="#C9D4F0">: </tspan><tspan fill="${NUM}">94.2</tspan></text>
  <text x="116" y="686" font-family="${mono}" font-size="25" fill="#C9D4F0">}</text>

  <!-- verdict callout -->
  <rect x="860" y="470" width="600" height="216" rx="16" fill="${RED}" fill-opacity="0.10" stroke="${RED}" stroke-opacity="0.5"/>
  <text x="890" y="528" font-family="${sans}" font-size="30" font-weight="800" fill="${RED}">🛑 EXIT TRAP</text>
  <text x="890" y="572" font-family="${sans}" font-size="23" font-weight="500" fill="#E7ECF8">The top holder's $8M bag vs</text>
  <text x="890" y="604" font-family="${sans}" font-size="23" font-weight="500" fill="#E7ECF8">~$976k liquidity = 94% impact.</text>
  <text x="890" y="648" font-family="${sans}" font-size="23" font-weight="700" fill="#ffffff">Their exit is your crater.</text>

  <!-- footer -->
  <text x="78" y="826" font-family="${sans}" font-size="34" font-weight="800" fill="#ffffff">402.com.tr</text>
  <text x="1522" y="826" text-anchor="end" font-family="${sans}" font-size="23" font-weight="500" fill="${MUTE}">paid in USDC · Coinbase CDP facilitator · Builder Codes</text>
</svg>`;

const out = process.argv[2] || "C:/Users/sukru.kucuk/Desktop/402-hero2.png";
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
