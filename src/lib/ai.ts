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
import { finish } from "./envelope";
import { anthropicClient, aiConfigured } from "./anthropic-client";

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";

// Re-exported because callers have imported it from here since before the
// client moved out; the definition lives with the client it describes.
export { aiConfigured };

/** Thrown-before-any-work when unconfigured → withX402 won't settle → buyer isn't charged. */
const client = (): Anthropic => anthropicClient();

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

/**
 * Did the model stop because it ran out of output budget?
 *
 * This is the failure with no symptom. Hitting `max_tokens` is not an error —
 * the API returns 200 and a body that simply ends, mid-word if it likes. A
 * measured case: 6K chars of English into Hindi returned 26 of 48 items, the
 * last one cut at `कार्`, and every field in our envelope said the call went
 * fine. `truncated` did not catch it: that flag has only ever described the
 * INPUT clamp, and the two are independent — a 5K-char input is never clamped
 * and can still overflow the output cap.
 *
 * So the caps below are set to cover what each endpoint advertises, and this
 * asks the question anyway, because a cap can always be beaten by a script that
 * spends more tokens per character than the ones we tested.
 */
function hitOutputCap(msg: Anthropic.Message): boolean {
  return msg.stop_reason === "max_tokens";
}

/** Summarize text into a few crisp bullet points. */
export async function aiSummarize(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  const { text, truncated } = clamp(input, 16000);

  const msg = await client().messages.create({
    model: MODEL,
    // 3-5 bullets is small, but a summary written in Devanagari or Thai costs
    // several times the tokens the same summary costs in English.
    max_tokens: 1200,
    system:
      "You are a precise summarizer. Return 3-5 short bullet points capturing the key facts. No preamble, no closing remarks — only the bullets, each starting with '- '.",
    messages: [{ role: "user", content: text }],
  });

  const out = textOf(msg);
  const bullets = out
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  // A cut-off final bullet is a half-fact, which is worse than one bullet fewer.
  const outputTruncated = hitOutputCap(msg);
  if (outputTruncated && bullets.length > 1) bullets.pop();
  return finish({ model: MODEL, bullets, truncated, outputTruncated, generatedAt: new Date().toISOString() });
}

function parseFields(raw: string | undefined): string[] {
  const fields = (raw || "summary")
    .split(",")
    .map((f) => f.trim().replace(/[^a-zA-Z0-9_]/g, "_"))
    .filter(Boolean)
    .slice(0, 10);
  return fields.length ? fields : ["summary"];
}

/** Extract structured fields from unstructured text. list=true extracts EVERY
 * repeated record (invoice lines, listings, table rows) as an array. */
/**
 * ONE schema for every extraction, whatever fields the caller asks for.
 *
 * The schema used to be built from the caller's `fields`, which made it novel on
 * almost every call — and a novel schema is expensive. Measured on the same
 * input: a schema the model had just seen answered in 2.15 s, while fresh ones
 * took 3.46 s, 5.35 s and 5.45 s for two, three and four fields. Since callers
 * rarely ask for the same field set twice, we were paying that penalty every
 * time, and a trust-leaderboard probe clocked this endpoint at 10.9 s.
 *
 * So the fields move out of the schema and into the prompt, and the schema
 * becomes a fixed list of name/value pairs. The response the caller receives is
 * unchanged — `toRecord` maps the pairs back onto their field names, in the
 * order they asked for them, filling anything the model omitted.
 */
interface Pair { field?: string; value?: string }

const PAIRS = {
  type: "array",
  items: {
    type: "object",
    properties: { field: { type: "string" }, value: { type: "string" } },
    required: ["field", "value"],
    additionalProperties: false,
  },
} as const;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    pairs: PAIRS,
    items: { type: "array", items: { type: "object", properties: { pairs: PAIRS }, required: ["pairs"], additionalProperties: false } },
  },
  required: [],
  additionalProperties: false,
} as const;

/** Pairs -> the object shape callers have always received. */
function toRecord(pairs: Pair[] | undefined, fields: string[]): Record<string, string> {
  const byName = new Map((pairs ?? []).map((p) => [String(p.field ?? "").trim().toLowerCase(), String(p.value ?? "")]));
  // Keyed by the caller's own field names and order — a model that renames or
  // reorders a field must not change the shape of what we return.
  return Object.fromEntries(fields.map((f) => [f, byName.get(f.toLowerCase()) ?? ""]));
}

export async function aiExtract(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  const fields = parseFields(params.fields);
  const listMode = /^(true|1|yes)$/i.test((params.list || "").trim());

  const { text, truncated } = clamp(input, 16000);

  const msg = await client().messages.create({
    model: MODEL,
    // List mode pulls every row out of up to 16K chars; 1500 tokens was well
    // short of what a long table needs, and the overflow surfaced as a JSON
    // parse error rather than as itself.
    max_tokens: listMode ? 8000 : 1200,
    system:
      (listMode
        ? "Extract EVERY occurrence of the requested record from the user's text — one entry per item/row/entry found. "
        : "Extract the requested fields from the user's text. ") +
      `The fields to extract, in this exact order, are: ${fields.join(", ")}. ` +
      "For each one emit an object with `field` set to the field name exactly as given and `value` set to what you found, or an empty string if it is not present. Emit every requested field, never skip one. Respond with JSON only.",
    output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
    messages: [{ role: "user", content: text }],
  });

  let raw: { items?: Array<{ pairs?: Pair[] }>; pairs?: Pair[] };
  try {
    raw = JSON.parse(textOf(msg)) as typeof raw;
  } catch {
    // Structured output that runs out of budget arrives as unclosed JSON. Both
    // paths throw — so withX402 never settles and the caller is not charged —
    // but only one of them is the caller's to act on.
    throw new Error(
      hitOutputCap(msg)
        ? "Result exceeded the output limit for this call. Send less text, or fewer fields, or split it across calls."
        : "Model did not return valid JSON",
    );
  }
  const data = listMode
    ? { items: (raw.items ?? []).map((r) => toRecord(r.pairs, fields)) }
    : toRecord(raw.pairs, fields);

  return finish({ model: MODEL, mode: listMode ? "list" : "single", fields, data, truncated, outputTruncated: hitOutputCap(msg), generatedAt: new Date().toISOString() });
}

/** Batch extract: the same fields across up to 10 texts in ONE call. */
export async function aiExtractBatch(params: Record<string, string>) {
  // text1..text10 (also accepts a single `texts` param with ||| separators).
  const texts: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const v = (params[`text${i}`] || "").trim();
    if (v) texts.push(v);
  }
  if (texts.length === 0 && params.texts) {
    for (const v of params.texts.split("|||")) if (v.trim()) texts.push(v.trim());
  }
  if (texts.length === 0) throw new Error("Provide text1..text10 (or texts= with ||| separators)");
  const fields = parseFields(params.fields);

  let anyTruncated = false;
  let budget = 40000; // total input cap keeps worst-case cost bounded
  const docs = texts.slice(0, 10).map((t, i) => {
    const { text, truncated } = clamp(t, Math.min(6000, budget));
    budget -= text.length;
    anyTruncated = anyTruncated || truncated;
    return `--- DOCUMENT ${i + 1} ---\n${text}`;
  });

  // Same fixed shape as aiExtract, and for the same reason: a schema built from
  // the caller's fields is novel on nearly every call, and novelty is seconds.
  const schema = {
    type: "object",
    properties: { documents: { type: "array", items: { type: "object", properties: { pairs: PAIRS }, required: ["pairs"], additionalProperties: false } } },
    required: ["documents"],
    additionalProperties: false,
  } as const;

  const msg = await client().messages.create({
    model: MODEL,
    // Ten documents' worth of fields; the old 2000 could truncate the tail
    // documents into an unparseable body on a full batch.
    max_tokens: 8000,
    system:
      "You will receive numbered documents. Extract the requested fields from EACH document, returning one entry per document in order (documents[0] = DOCUMENT 1). " +
      `The fields to extract, in this exact order, are: ${fields.join(", ")}. ` +
      "For each one emit an object with `field` set to the field name exactly as given and `value` set to what you found, or an empty string if it is not present in that document. Emit every requested field for every document. Respond with JSON only.",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: docs.join("\n\n") }],
  });

  let data: { documents?: Array<{ pairs?: Pair[] }> };
  try {
    data = JSON.parse(textOf(msg)) as typeof data;
  } catch {
    throw new Error(
      hitOutputCap(msg)
        ? "Result exceeded the output limit for this call. Send fewer documents, or fewer fields, or split it across calls."
        : "Model did not return valid JSON",
    );
  }
  const documents = (data.documents ?? []).map((d) => toRecord(d.pairs, fields));
  return finish({
    model: MODEL,
    fields,
    documentCount: texts.length,
    // The contract is one entry per document, in order. If the budget ran out
    // after document 6 of 10, saying so beats letting the caller line up
    // document 7's answer against document 7's input and find nothing there.
    documentsReturned: documents.length,
    documents,
    truncated: anyTruncated,
    outputTruncated: hitOutputCap(msg),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Where ai-translate stops being one price.
 *
 * The endpoint advertises 6K characters into ANY language, and "any" is what
 * breaks a flat price. Output tokens scale with the input, and a script that
 * spends several tokens per character can fill the whole 6000-token budget:
 * $0.030 of Haiku output plus the input, against a $0.03 sale. The margin was
 * never negative on the calls we actually saw — English-to-Turkish prose costs
 * fractions of a cent — but the worst case an agent is entitled to ask for was
 * priced below cost, and an agent that finds that will keep asking for it.
 *
 * So the long half pays for the budget it can reach. This threshold is exported
 * rather than repeated in the route: the two payment rails read the price from
 * one function, and that function has to read the split from one place too, or
 * we charge for one tier and serve the other (see test/price-rails.test.ts).
 */
export const TRANSLATE_LONG_CHARS = 2000;

/** True when a translate request falls in the long (higher) price tier. */
export function translateIsLong(text: string): boolean {
  return (text || "").trim().length > TRANSLATE_LONG_CHARS;
}

/** Translate text into a target language. */
export async function aiTranslate(params: Record<string, string>) {
  const input = (params.text || "").trim();
  if (!input) throw new Error("Missing 'text'");
  // Sanitize the language so it can't inject instructions into the system prompt.
  const to = ((params.to || "English").replace(/[^a-zA-Z\s-]/g, "").trim().slice(0, 40)) || "English";
  const { text, truncated } = clamp(input, 6000);

  const msg = await client().messages.create({
    model: MODEL,
    // We advertise 6K chars into ANY language, so the budget has to cover the
    // expensive end of "any". 2500 was enough for Latin scripts and cut Hindi
    // roughly in half. Raising a cap costs nothing on calls that don't reach it
    // — we pay for tokens produced, not tokens allowed.
    max_tokens: 6000,
    system: `Translate the user's text into ${to}. Output only the translation — no notes, no quotes, no preamble.`,
    messages: [{ role: "user", content: text }],
  });

  return finish({
    model: MODEL,
    to,
    translation: textOf(msg),
    truncated,
    outputTruncated: hitOutputCap(msg),
    generatedAt: new Date().toISOString(),
  });
}
