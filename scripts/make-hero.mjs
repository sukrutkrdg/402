// Generates the tweet hero / OG card as a PNG using sharp (SVG → raster).
// Design: Base-blue, bold, uncluttered — name, the 216 number, what it does,
// settlement rail, integrations, URL, "Built on Base".
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const W = 1600, H = 900;
const BASE = "#0052FF";       // Base brand blue
const BASE_DK = "#0038B8";
const INK = "#0A1A3F";

const chip = (x, y, w, label) => `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="60" rx="30" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>
    <text x="${x + w / 2}" y="${y + 39}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="27" font-weight="600" fill="#ffffff">${label}</text>
  </g>`;

const badge = (x, y, w, label) => `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="54" rx="12" fill="#ffffff"/>
    <text x="${x + w / 2}" y="${y + 36}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" fill="${BASE}">${label}</text>
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BASE}"/>
      <stop offset="1" stop-color="${BASE_DK}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.22" r="0.6">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- top row: wordmark + Built on Base -->
  <g>
    <circle cx="90" cy="92" r="30" fill="#ffffff"/>
    <text x="90" y="104" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="800" fill="${BASE}">4</text>
    <text x="140" y="104" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="800" fill="#ffffff">x402 Bazaar</text>
  </g>
  <g>
    <rect x="1210" y="62" width="300" height="60" rx="30" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.4" stroke-width="1.5"/>
    <circle cx="1248" cy="92" r="17" fill="#ffffff"/>
    <text x="1280" y="102" font-family="Segoe UI, Arial, sans-serif" font-size="29" font-weight="700" fill="#ffffff">Built on Base</text>
  </g>

  <!-- headline -->
  <text x="90" y="300" font-family="Segoe UI, Arial, sans-serif" font-size="128" font-weight="800" fill="#ffffff" letter-spacing="-2">216 live APIs</text>
  <text x="96" y="372" font-family="Segoe UI, Arial, sans-serif" font-size="46" font-weight="500" fill="#ffffff" opacity="0.92">Pay-per-call marketplace for AI agents — on Base &amp; NEAR</text>

  <!-- feature chips -->
  ${chip(96, 430, 250, "Token safety")}
  ${chip(366, 430, 280, "Exit-liquidity")}
  ${chip(666, 430, 230, "MEV guard")}
  ${chip(916, 430, 300, "Owner-powers")}
  ${chip(96, 510, 320, "Price-impact")}
  ${chip(436, 510, 360, "Sanctions / OFAC")}
  ${chip(816, 510, 400, "x402 market intel")}

  <!-- settlement rail -->
  <text x="96" y="640" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="600" fill="#ffffff" opacity="0.95">
    Paid in USDC · Coinbase CDP facilitator · Builder Codes (ERC-8021) · in the x402 discovery index
  </text>

  <!-- integrations -->
  <text x="96" y="726" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="600" fill="#ffffff" opacity="0.8">Use from:</text>
  ${badge(240, 700, 140, "MCP")}
  ${badge(400, 700, 220, "AgentKit")}
  ${badge(640, 700, 200, "ElizaOS")}

  <!-- URL footer -->
  <text x="96" y="828" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="800" fill="#ffffff">402.com.tr</text>
  <text x="1504" y="828" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="500" fill="#ffffff" opacity="0.85">+ 82 tokenized stocks · B20 suite · Cobalt</text>
</svg>`;

const out = process.argv[2] || "public/og-hero.png";
writeFileSync("scripts/.hero.svg", svg);
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("wrote", out);
