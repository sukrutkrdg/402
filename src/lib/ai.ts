/**
 * Claude-powered service handlers (the "valuable" paid endpoints).
 *
 * Each function calls the Anthropic API server-side. They run *inside* the x402
 * handler, which only settles payment when the handler returns successfully — so
 * if a Claude call throws, withX402 returns an error and the buyer is NOT
 * charged. That's why these throw on failure instead of returning a stub.
 *
 * Model is configurable via ANTHROPIC_MODEL. Default is claude-haiku-4-5 —
 * chosen for fat margins on these micro-priced endpoints (~$0.003/call vs ~$0.02
 * price). Set ANTHROPIC_MODEL=claude-opus-4-8 to trade margin for max quality.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function client(): Anthropic {
  if (!aiConfigured()) {
    // Thrown before any work → withX402 won't settle → buyer isn't charged.
    throw new Error("AI not configured: set ANTHROPIC_API_KEY");
  }
  return new Anthropic();
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function clamp(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** Summarize text into a few crisp bullet points. */
export async function aiSummarize(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  const { text, truncated } = clamp(input, 6000);

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 500,
    system:
      "You are a precise summarizer. Return 3-5 short bullet points capturing the key facts. No preamble, no closing remarks — only the bullets, each starting with '- '.",
    messages: [{ role: "user", content: text }],
  });

  const out = textOf(msg);
  const bullets = out
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  return { model: MODEL, bullets, truncated, generatedAt: new Date().toISOString() };
}

/** Extract structured fields from unstructured text. */
export async function aiExtract(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  const fields = (params.fields || "summary")
    .split(",")
    .map((f) => f.trim().replace(/[^a-zA-Z0-9_]/g, "_"))
    .filter(Boolean)
    .slice(0, 10);
  if (fields.length === 0) fields.push("summary");

  const { text, truncated } = clamp(input, 6000);
  const schema = {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
    required: fields,
    additionalProperties: false,
  };

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 600,
    system:
      "Extract the requested fields from the user's text. If a field is not present, use an empty string. Respond with JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: text }],
  });

  let data: unknown;
  try {
    data = JSON.parse(textOf(msg));
  } catch {
    throw new Error("Model did not return valid JSON");
  }
  return { model: MODEL, fields, data, truncated, generatedAt: new Date().toISOString() };
}

/** Translate text into a target language. */
export async function aiTranslate(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  // Sanitize the language so it can't inject instructions into the system prompt.
  const to = ((params.to || "English").replace(/[^a-zA-Z\s-]/g, "").trim().slice(0, 40)) || "English";
  const { text, truncated } = clamp(input, 1200);

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: `Translate the user's text into ${to}. Output only the translation — no notes, no quotes, no preamble.`,
    messages: [{ role: "user", content: text }],
  });

  return { model: MODEL, to, translation: textOf(msg), truncated, generatedAt: new Date().toISOString() };
}
