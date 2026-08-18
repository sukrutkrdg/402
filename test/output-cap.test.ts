import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Running out of output budget is the failure with no symptom.
 *
 * `max_tokens` is not an error condition: the API returns 200 and a body that
 * simply stops, mid-word if it likes. Measured in production before the fix —
 * 6K chars of English into Hindi through ai-translate:
 *
 *   48 items in       26 items out      last one cut at "कार्"
 *   truncated: true, but only because the INPUT was clamped at 6000 chars
 *
 * That last line is the trap. `truncated` has only ever described the input
 * clamp; a 5K-char input is never clamped and can still overflow the output
 * cap, and then every field in the envelope reports a clean call. The buyer
 * paid $0.03 for half a translation with nothing saying so.
 *
 * These tests hold two things: the caps cover what each endpoint advertises,
 * and the handlers ask about `stop_reason` anyway — because a cap can always be
 * beaten by a script that spends more tokens per character than the ones tested.
 */
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { aiSummarize, aiTranslate, aiExtract, aiExtractBatch } from "@/lib/ai";

const reply = (text: string, stop: string) => ({
  content: [{ type: "text", text }],
  stop_reason: stop,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("a cut-off answer says it was cut off", () => {
  it("ai-translate flags the overflow separately from the input clamp", async () => {
    createMock.mockResolvedValue(reply("आइटम 26: वायलिन कार्", "max_tokens"));
    // Short input: nothing was clamped, so `truncated` alone would say all is well.
    const res = await aiTranslate({ text: "Item 1: the harbour.", to: "Hindi" });
    expect(res.truncated, "input was never clamped").toBe(false);
    expect(res.outputTruncated, "but the answer stops mid-word").toBe(true);
  });

  it("reports a complete translation as complete", async () => {
    createMock.mockResolvedValue(reply("Liman.", "end_turn"));
    const res = await aiTranslate({ text: "The harbour.", to: "Turkish" });
    expect(res.outputTruncated).toBe(false);
    expect(res.translation).toBe("Liman.");
  });

  it("drops a half-written final bullet rather than serving half a fact", async () => {
    createMock.mockResolvedValue(reply("- Volume rose 9%\n- Median gas stayed under a ten", "max_tokens"));
    const res = await aiSummarize({ text: "..." });
    expect(res.bullets).toEqual(["Volume rose 9%"]);
    expect(res.outputTruncated).toBe(true);
  });

  it("keeps a lone bullet even when truncated, so the caller gets something", async () => {
    createMock.mockResolvedValue(reply("- Volume rose", "max_tokens"));
    const res = await aiSummarize({ text: "..." });
    expect(res.bullets).toEqual(["Volume rose"]);
    expect(res.outputTruncated).toBe(true);
  });

  it("tells an extract caller the result was too big, not that the model misbehaved", async () => {
    // Structured output that runs out of budget arrives as unclosed JSON, which
    // is exactly what a schema-ignoring model looks like from the catch site.
    createMock.mockResolvedValue(reply('{"items":[{"pairs":[{"field":"a","val', "max_tokens"));
    await expect(aiExtract({ text: "x", fields: "a", list: "true" })).rejects.toThrow(/exceeded the output limit/i);

    createMock.mockResolvedValue(reply("not json at all", "end_turn"));
    await expect(aiExtract({ text: "x", fields: "a" })).rejects.toThrow(/did not return valid JSON/i);
  });

  it("says how many of the batch's documents actually came back", async () => {
    // The contract is one entry per document in order. Silently returning six
    // for ten leaves the caller matching document 7 against nothing.
    createMock.mockResolvedValue(
      reply(JSON.stringify({ documents: [{ pairs: [{ field: "a", value: "1" }] }] }), "max_tokens"),
    );
    const res = await aiExtractBatch({ text1: "one", text2: "two", text3: "three", fields: "a" });
    expect(res.documentCount).toBe(3);
    expect(res.documentsReturned).toBe(1);
    expect(res.outputTruncated).toBe(true);
  });

  it("never charges for an unparseable batch either way", async () => {
    createMock.mockResolvedValue(reply('{"documents":[{"pai', "max_tokens"));
    await expect(aiExtractBatch({ text1: "one", fields: "a" })).rejects.toThrow(/exceeded the output limit/i);
  });
});

describe("the caps cover what the catalogue advertises", () => {
  const capFor = async (fn: () => Promise<unknown>) => {
    createMock.mockResolvedValue(reply("{}", "end_turn"));
    await fn().catch(() => {});
    return createMock.mock.calls.at(-1)![0].max_tokens as number;
  };

  it("translate budgets for 6K chars into a token-heavy script", async () => {
    // Hindi consumed the old 2500-token cap at roughly the halfway mark of a
    // 6K-char input, so anything at or below ~5000 still cuts real requests.
    const cap = await capFor(() => aiTranslate({ text: "hello", to: "Hindi" }));
    expect(cap).toBeGreaterThanOrEqual(6000);
  });

  it("list extraction budgets for many rows out of a 16K-char input", async () => {
    const single = await capFor(() => aiExtract({ text: "x", fields: "a" }));
    const list = await capFor(() => aiExtract({ text: "x", fields: "a", list: "true" }));
    expect(list).toBeGreaterThanOrEqual(8000);
    expect(list, "a list of records needs more room than one record").toBeGreaterThan(single);
  });

  it("batch budgets for ten documents, not one", async () => {
    const cap = await capFor(() => aiExtractBatch({ text1: "one", fields: "a" }));
    expect(cap).toBeGreaterThanOrEqual(8000);
  });
});
