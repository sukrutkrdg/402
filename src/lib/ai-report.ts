/**
 * AI Token Report — the flagship differentiated service.
 *
 * Aggregates our own on-chain services (risk + holder distribution + price +
 * OFAC sanctions) and asks Claude to synthesize a concise, structured
 * due-diligence verdict for an AI trading agent. This is value you can't get
 * free anywhere: it combines data we already fetch with the LLM reasoning layer.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { tokenRisk } from "./onchain";
import { holderDistribution } from "./holders";
import { tokenPrice } from "./onchain-extra";
import { sanctionsCheck } from "./compliance";
import { walletNetworth, walletSummary, walletActivity } from "./covalent";
import { trendingTokens } from "./onchain-extra2";
import { newTokens } from "./onchain-extra4";

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function aiTokenReport(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… token address");
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    // Thrown before any work → withX402 won't settle → buyer isn't charged.
    throw new Error("AI not configured: set ANTHROPIC_API_KEY");
  }

  // Gather signals from our own services in parallel (best-effort each).
  const [risk, holders, price, sanctions] = await Promise.allSettled([
    tokenRisk({ address }),
    holderDistribution({ address }),
    tokenPrice({ address }),
    sanctionsCheck({ address }),
  ]);
  const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const data = {
    risk: val(risk),
    holders: val(holders),
    price: val(price),
    sanctions: val(sanctions),
  };
  if (!data.risk && !data.price && !data.holders) {
    throw new Error("No on-chain data available for this token");
  }

  const facts = JSON.stringify(data).slice(0, 6000);

  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["avoid", "high_caution", "caution", "neutral", "favorable"] },
      safetyScore: { type: "integer" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      summary: { type: "string" },
      factors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["good", "neutral", "warning", "critical"] },
            note: { type: "string" },
          },
          required: ["name", "status", "note"],
          additionalProperties: false,
        },
      },
      risks: { type: "array", items: { type: "string" } },
      positives: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "safetyScore", "confidence", "summary", "factors", "risks", "positives"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 900,
    system:
      "You are a Base token due-diligence analyst for an autonomous trading agent. " +
      "Given JSON facts (risk score/flags, holder concentration, price/liquidity, OFAC sanctions), " +
      "produce a concise, structured assessment with:\n" +
      "- safetyScore: integer 0-100 (0 = certain scam/honeypot, 100 = clean & safe). Be conservative.\n" +
      "- confidence: how complete the underlying data is (low if key signals are missing).\n" +
      "- factors: one entry per dimension you can assess — e.g. 'Contract safety', 'Holder concentration', " +
      "'Liquidity', 'Sanctions', 'Price/Momentum' — each with a status (good/neutral/warning/critical) and a one-line note.\n" +
      "- verdict, summary (1-2 sentences), risks, positives.\n" +
      "Be conservative: honeypot, unverified source, high holder concentration, very low liquidity, " +
      "mintable/pausable, or any OFAC sanction => low score + 'avoid'/'high_caution'. " +
      "Describe risk factually; this is not financial advice. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Token ${address} facts:\n${facts}` }],
  });

  let parsed: {
    verdict?: string;
    safetyScore?: number;
    confidence?: string;
    summary?: string;
    factors?: Array<{ name: string; status: string; note: string }>;
    risks?: string[];
    positives?: string[];
  };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    address,
    verdict: parsed.verdict ?? "neutral",
    safetyScore: typeof parsed.safetyScore === "number" ? parsed.safetyScore : null,
    confidence: parsed.confidence ?? "low",
    summary: parsed.summary ?? "",
    factors: parsed.factors ?? [],
    risks: parsed.risks ?? [],
    positives: parsed.positives ?? [],
    data,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * AI Wallet Report — flagship wallet intelligence. Aggregates net worth, age/
 * activity and recent transactions, then Claude synthesizes a verdict.
 */
export async function aiWalletReport(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… address");
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("AI not configured: set ANTHROPIC_API_KEY");
  }

  const [networth, summary, activity] = await Promise.allSettled([
    walletNetworth({ address }),
    walletSummary({ address }),
    walletActivity({ address }),
  ]);
  const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const data = { networth: val(networth), summary: val(summary), activity: val(activity) };
  if (!data.networth && !data.summary) throw new Error("No wallet data available for this address");

  const facts = JSON.stringify(data).slice(0, 6000);
  const schema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["fresh_or_risky", "new", "normal", "established", "power_user"] },
      summary: { type: "string" },
      observations: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "summary", "observations"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      "You are a wallet analyst for an autonomous agent. Given JSON facts (net worth, age/activity, recent txs), " +
      "produce a concise neutral profile: is this wallet fresh/new (possible sybil or throwaway), normal, or an " +
      "established/active user? Note net worth, age in days, activity level, and anything notable. Not financial advice. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Wallet ${address} facts:\n${facts}` }],
  });

  let parsed: { verdict?: string; summary?: string; observations?: string[] };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    address,
    verdict: parsed.verdict ?? "normal",
    summary: parsed.summary ?? "",
    observations: parsed.observations ?? [],
    data,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * AI Market Brief — second flagship. A zoom-OUT companion to AI Token Report:
 * aggregates trending + newly-listed Base tokens and has Claude write a concise
 * situational brief (mood, highlights, new & notable, cautions). Lets an agent
 * get market context in one paid call instead of many.
 */
export async function aiMarketBrief(_params: Record<string, string>) {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("AI not configured: set ANTHROPIC_API_KEY");
  }

  const [trending, fresh] = await Promise.allSettled([trendingTokens({}), newTokens({})]);
  const val = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const data = { trending: val(trending), newTokens: val(fresh) };
  if (!data.trending && !data.newTokens) {
    throw new Error("No market data available right now");
  }

  const facts = JSON.stringify(data).slice(0, 6500);
  const schema = {
    type: "object",
    properties: {
      mood: { type: "string", enum: ["bullish", "active", "mixed", "quiet", "risky"] },
      summary: { type: "string" },
      highlights: { type: "array", items: { type: "string" } },
      newAndNotable: { type: "array", items: { type: "string" } },
      cautions: { type: "array", items: { type: "string" } },
    },
    required: ["mood", "summary", "highlights", "newAndNotable", "cautions"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 900,
    system:
      "You are a Base onchain market analyst for autonomous agents. Given JSON facts " +
      "(trending tokens with boost amounts/descriptions, and newly-listed tokens with descriptions), " +
      "write a concise situational brief: overall market mood, key highlights (what's getting attention), " +
      "new & notable launches, and cautions. Treat freshly-listed/unknown tokens as carrying rug risk and " +
      "flag them in cautions. Be factual, never hype. This is not financial advice. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Base market snapshot:\n${facts}` }],
  });

  let parsed: {
    mood?: string;
    summary?: string;
    highlights?: string[];
    newAndNotable?: string[];
    cautions?: string[];
  };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    mood: parsed.mood ?? "mixed",
    summary: parsed.summary ?? "",
    highlights: parsed.highlights ?? [],
    newAndNotable: parsed.newAndNotable ?? [],
    cautions: parsed.cautions ?? [],
    sources: {
      trending: data.trending ? (data.trending as { count?: number }).count ?? 0 : 0,
      newTokens: data.newTokens ? (data.newTokens as { count?: number }).count ?? 0 : 0,
    },
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}
