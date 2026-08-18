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
  const { text, truncated } = clamp(input, 16000);

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
  return finish({ model: MODEL, bullets, truncated, generatedAt: new Date().toISOString() });
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
    max_tokens: listMode ? 1500 : 600,
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
    throw new Error("Model did not return valid JSON");
  }
  const data = listMode
    ? { items: (raw.items ?? []).map((r) => toRecord(r.pairs, fields)) }
    : toRecord(raw.pairs, fields);

  return finish({ model: MODEL, mode: listMode ? "list" : "single", fields, data, truncated, generatedAt: new Date().toISOString() });
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
    max_tokens: 2000,
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
    throw new Error("Model did not return valid JSON");
  }
  return finish({
    model: MODEL,
    fields,
    documentCount: texts.length,
    documents: (data.documents ?? []).map((d) => toRecord(d.pairs, fields)),
    truncated: anyTruncated,
    generatedAt: new Date().toISOString(),
  });
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
    max_tokens: 2500,
    system: `Translate the user's text into ${to}. Output only the translation — no notes, no quotes, no preamble.`,
    messages: [{ role: "user", content: text }],
  });

  return finish({ model: MODEL, to, translation: textOf(msg), truncated, generatedAt: new Date().toISOString() });
}
