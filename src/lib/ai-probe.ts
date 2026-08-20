/**
 * Is the Anthropic account actually able to answer right now?
 *
 * One token, ~$0.00002, and it distinguishes the failure that matters. An
 * exhausted balance is not an API error: it is a billing state that turns every
 * AI endpoint into a 400 until someone tops up, and no amount of retrying or
 * redeploying moves it.
 *
 * Shared so the standalone probe route and the daily spend cron ask the same
 * question the same way — the cron needs the answer for a second reason, which
 * is not to pay for re-seeding endpoints that cannot succeed.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";

export interface AiProbe {
  ok: boolean;
  /** True only for billing exhaustion — the one an operator must act on. */
  creditsExhausted: boolean;
  reason?: string;
  detail?: string;
}

export async function probeAi(): Promise<AiProbe> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return { ok: false, creditsExhausted: false, reason: "ANTHROPIC_API_KEY not set" };
  }
  try {
    await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true, creditsExhausted: false };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Billing exhaustion surfaces as invalid_request_error naming the balance.
    const credits = /credit balance|billing|purchase credits/i.test(raw);
    return {
      ok: false,
      creditsExhausted: credits,
      reason: credits
        ? "ANTHROPIC CREDITS EXHAUSTED — every AI service is down. Top up at console.anthropic.com."
        : "Anthropic API error",
      detail: raw.slice(0, 300),
    };
  }
}
