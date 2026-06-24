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
      summary: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      positives: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "summary", "risks", "positives"],
    additionalProperties: false,
  };

  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system:
      "You are a Base token due-diligence analyst for an autonomous trading agent. " +
      "Given JSON facts (risk score/flags, holder concentration, price/liquidity, OFAC sanctions), " +
      "produce a concise neutral assessment. Be conservative: honeypot, unverified source, high holder " +
      "concentration, very low liquidity, mintable/pausable, or any OFAC sanction => 'avoid' or 'high_caution'. " +
      "Describe risk factually; this is not financial advice. Keep summary to 1-2 sentences. JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `Token ${address} facts:\n${facts}` }],
  });

  let parsed: { verdict?: string; summary?: string; risks?: string[]; positives?: string[] };
  try {
    parsed = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }

  return {
    address,
    verdict: parsed.verdict ?? "neutral",
    summary: parsed.summary ?? "",
    risks: parsed.risks ?? [],
    positives: parsed.positives ?? [],
    data,
    model: MODEL,
    generatedAt: new Date().toISOString(),
  };
}
