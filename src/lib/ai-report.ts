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
import { tokenPrice, txDecode } from "./onchain-extra";
import { sanctionsCheck } from "./compliance";
import { walletNetworth, walletSummary, walletActivity, tokenApprovals } from "./covalent";
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

/**
 * AI Wallet Security Audit — pulls a wallet's token approvals and has Claude
 * produce a security report: what can drain it, which approvals to revoke, why.
 */
export async function aiWalletSecurity(params: Record<string, string>) {
  const address = (params.address || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Provide a valid 0x… wallet address");
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("AI not configured: set ANTHROPIC_API_KEY");

  let approvals: Awaited<ReturnType<typeof tokenApprovals>>;
  try {
    approvals = await tokenApprovals({ address });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Approval data unavailable");
  }

  const facts = JSON.stringify(approvals).slice(0, 6000);
  const schema = {
    type: "object",
    properties: {
      riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
      summary: { type: "string" },
      revokeRecommendations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            token: { type: "string" },
            spender: { type: "string" },
            reason: { type: "string" },
          },
          required: ["token", "spender", "reason"],
          additionalProperties: false,
        },
      },
      observations: { type: "array", items: { type: "string" } },
    },
    required: ["riskLevel", "summary", "revokeRecommendations", "observations"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 900,
    system:
      "You are a wallet-security auditor for an autonomous agent. Given JSON facts about a wallet's active " +
      "token approvals (spenders, allowances, USD value at risk, risk factors), produce a security audit. " +
      "Recommend revoking: unlimited/very large allowances, approvals to unverified or suspicious spenders, " +
      "and any allowance with high USD value at risk. Set riskLevel by the worst exposure. Be concrete and " +
      "actionable; reference token + spender. Not financial advice. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Wallet ${address} approvals:\n${facts}` }],
  });

  let parsed: {
    riskLevel?: string;
    summary?: string;
    revokeRecommendations?: Array<{ token: string; spender: string; reason: string }>;
    observations?: string[];
  };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    address,
    riskLevel: parsed.riskLevel ?? "low",
    totalUsdAtRisk: (approvals as { totalUsdAtRisk?: number }).totalUsdAtRisk ?? 0,
    approvalCount: (approvals as { approvalCount?: number }).approvalCount ?? 0,
    summary: parsed.summary ?? "",
    revokeRecommendations: parsed.revokeRecommendations ?? [],
    observations: parsed.observations ?? [],
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * AI Transaction Explainer — decodes a Base tx and has Claude explain in plain
 * English what it did, plus a risk read. Turns raw calldata into an answer.
 */
export async function aiTxExplain(params: Record<string, string>) {
  const hash = (params.hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Provide a valid 0x… transaction hash");
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("AI not configured: set ANTHROPIC_API_KEY");

  let decoded: Awaited<ReturnType<typeof txDecode>>;
  try {
    decoded = await txDecode({ hash });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Transaction not found");
  }

  const facts = JSON.stringify(decoded).slice(0, 6000);
  const schema = {
    type: "object",
    properties: {
      action: { type: "string" },
      plainEnglish: { type: "string" },
      risk: { type: "string", enum: ["none", "low", "medium", "high"] },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["action", "plainEnglish", "risk", "notes"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system:
      "You explain Base transactions for an autonomous agent. Given JSON facts (from, to, ETH value, status, " +
      "gas, method selector), infer what the transaction did and write a one-paragraph plain-English explanation. " +
      "Recognize common selectors (0x095ea7b3 = ERC-20 approve, 0xa9059cbb = transfer, router/swap selectors). " +
      "Flag risk: a failed tx, an approval (especially unlimited) to an unknown spender, or a high-value transfer. " +
      "If the method is unknown, say so honestly. Not financial advice. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Transaction ${hash} facts:\n${facts}` }],
  });

  let parsed: { action?: string; plainEnglish?: string; risk?: string; notes?: string[] };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    hash,
    action: parsed.action ?? "unknown",
    plainEnglish: parsed.plainEnglish ?? "",
    risk: parsed.risk ?? "none",
    notes: parsed.notes ?? [],
    data: decoded,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}
