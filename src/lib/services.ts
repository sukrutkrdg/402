/**
 * The marketplace catalog.
 *
 * Each entry is an x402-protected, pay-per-call API. The `handler` produces the
 * actual response a buyer receives *after* their payment settles. Everything is
 * self-contained (no external API keys) so the demo runs out of the box — but
 * each handler is a normal async function, so swapping in a real upstream API or
 * an LLM call is a one-line change.
 */

import { aiSummarize, aiExtract, aiTranslate } from "./ai";

export interface ServiceParam {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
}

export interface ServiceDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Human price string passed straight to x402 (USD → USDC on Base). */
  price: string;
  icon: string;
  category: string;
  params: ServiceParam[];
  handler: (params: Record<string, string>) => Promise<unknown>;
}

// ---- tiny deterministic helpers so demo output looks alive but stays cheap ----

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const QUOTES = [
  "In crypto, patience is a position.",
  "The chain doesn't lie; it just waits to be read.",
  "Decentralization is a verb, not a noun.",
  "Pay-per-call is the unit economics of the agent era.",
  "Attribution turns anonymous traffic into a growth engine.",
  "Settle small, settle often, settle onchain.",
];

const ASSETS: Record<string, number> = {
  BTC: 67000,
  ETH: 3500,
  SOL: 165,
  BASE: 1.0,
};

export const SERVICES: ServiceDef[] = [
  {
    id: "ai-summarize",
    name: "AI Summarize",
    tagline: "Any text → crisp bullet points",
    description:
      "Paste text and get a 3-5 bullet summary from Claude. Pay-per-call — no API key or subscription needed on your side.",
    price: "$0.02",
    icon: "🧠",
    category: "AI",
    params: [{ name: "text", label: "Text to summarize", placeholder: "Paste an article, email, or notes…", required: true, multiline: true }],
    handler: aiSummarize,
  },
  {
    id: "ai-extract",
    name: "AI Extract",
    tagline: "Unstructured text → structured JSON",
    description:
      "Pull named fields out of any text as clean JSON (e.g. name, email, company, date). Powered by Claude structured outputs.",
    price: "$0.02",
    icon: "🗂️",
    category: "AI",
    params: [
      { name: "text", label: "Source text", placeholder: "Paste text containing the data…", required: true, multiline: true },
      { name: "fields", label: "Fields (comma-separated)", placeholder: "name, email, company, date" },
    ],
    handler: aiExtract,
  },
  {
    id: "ai-translate",
    name: "AI Translate",
    tagline: "Translate text to any language",
    description: "Translate text into a target language with Claude. One micro-payment per translation.",
    price: "$0.02",
    icon: "🌐",
    category: "AI",
    params: [
      { name: "text", label: "Text to translate", placeholder: "Merhaba dünya…", required: true, multiline: true },
      { name: "to", label: "Target language", placeholder: "English" },
    ],
    handler: aiTranslate,
  },
  {
    id: "market-snapshot",
    name: "Market Snapshot",
    tagline: "Live-style price board for top assets",
    description:
      "Returns a snapshot of major crypto assets with a pseudo-random intraday move. One USDC micro-payment per call.",
    price: "$0.001",
    icon: "📈",
    category: "Markets",
    params: [],
    handler: async () => {
      const now = Date.now();
      const assets = Object.entries(ASSETS).map(([symbol, base]) => {
        const drift = ((hash(symbol + Math.floor(now / 60000)) % 800) - 400) / 10000;
        const price = +(base * (1 + drift)).toFixed(base < 10 ? 4 : 2);
        return { symbol, price, change24h: +(drift * 100).toFixed(2) };
      });
      return { asOf: new Date(now).toISOString(), currency: "USD", assets };
    },
  },
  {
    id: "weather",
    name: "Weather Oracle",
    tagline: "Current conditions for any city",
    description:
      "Pass a city and get a structured weather report. Mirrors the canonical x402 `/weather` example so you can compare wire formats.",
    price: "$0.001",
    icon: "🌦️",
    category: "Data",
    params: [{ name: "city", label: "City", placeholder: "Istanbul", required: true }],
    handler: async (p) => {
      const city = (p.city || "Istanbul").slice(0, 40);
      const seed = hash(city.toLowerCase());
      const conditions = ["Clear", "Cloudy", "Rain", "Windy", "Snow", "Fog"];
      return {
        city,
        condition: pick(conditions, seed),
        tempC: 8 + (seed % 25),
        humidity: 40 + (seed % 55),
        windKph: 3 + (seed % 30),
        asOf: new Date().toISOString(),
      };
    },
  },
  {
    id: "quote",
    name: "Alpha Quote",
    tagline: "One sharp line of market wisdom",
    description: "A rotating quote feed. The cheapest possible paid endpoint — perfect for testing your wiring.",
    price: "$0.001",
    icon: "💬",
    category: "Fun",
    params: [],
    handler: async () => {
      const seed = hash(String(Math.floor(Date.now() / 30000)));
      return { quote: pick(QUOTES, seed), at: new Date().toISOString() };
    },
  },
  {
    id: "secure-token",
    name: "Secure Token",
    tagline: "Cryptographically strong random IDs",
    description:
      "Generate N url-safe random tokens server-side. Demonstrates a paid utility endpoint with a query parameter.",
    price: "$0.002",
    icon: "🔐",
    category: "Utility",
    params: [{ name: "count", label: "How many", placeholder: "3" }],
    handler: async (p) => {
      const count = Math.min(Math.max(parseInt(p.count || "1", 10) || 1, 1), 10);
      const tokens = Array.from({ length: count }, () => {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        return Buffer.from(bytes).toString("base64url");
      });
      return { count, tokens, generatedAt: new Date().toISOString() };
    },
  },
];

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}
