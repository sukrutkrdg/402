import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { webSearch, searchConfigured } from "@/lib/web-search";

/**
 * The refusals matter more than the happy path here: withX402 settles only on a
 * handler that returns, so every throw below is a call the buyer is not charged
 * for. A refusal that silently became a return would start charging for nothing.
 */

const KEY = "TAVILY_API_KEY";
const original = process.env[KEY];

/** Minimal upstream body — only the fields the handler actually reads. */
const upstreamOk = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    query: "q",
    answer: "an answer",
    results: [{ title: "T", url: "https://e.com", content: "snippet", score: 0.79215926 }],
    response_time: 1.13,
    ...over,
  }),
});

beforeEach(() => {
  process.env[KEY] = "tvly-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("searchConfigured", () => {
  it("tracks the key", () => {
    expect(searchConfigured()).toBe(true);
    delete process.env[KEY];
    expect(searchConfigured()).toBe(false);
  });
});

describe("webSearch refusals (buyer is not charged)", () => {
  it("throws when the key is missing, before any fetch", async () => {
    delete process.env[KEY];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(webSearch({ query: "anything" })).rejects.toThrow(/TAVILY_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on an empty query, before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(webSearch({ query: "   " })).rejects.toThrow(/Missing 'query'/);
    await expect(webSearch({})).rejects.toThrow(/Missing 'query'/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the upstream status instead of a generic failure", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 432, text: async () => "out of credits" }));
    await expect(webSearch({ query: "q" })).rejects.toThrow(/432.*out of credits/);
  });

  it("says plainly that an unreachable upstream did not charge", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    await expect(webSearch({ query: "q" })).rejects.toThrow(/not charged/);
  });
});

describe("webSearch request shaping", () => {
  const bodyOf = async (params: Record<string, string>) => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return upstreamOk();
    });
    await webSearch(params);
    return sent;
  };

  it("clamps maxResults into 1..20 and defaults to 5", async () => {
    expect((await bodyOf({ query: "q" })).max_results).toBe(5);
    expect((await bodyOf({ query: "q", maxResults: "999" })).max_results).toBe(20);
    expect((await bodyOf({ query: "q", maxResults: "7" })).max_results).toBe(7);
    expect((await bodyOf({ query: "q", maxResults: "-3" })).max_results).toBe(1);
  });

  it("falls back to the default for a value that asks for nothing", async () => {
    // 0 and junk are not a request for zero results — they carry no intent, so
    // they take the default rather than clamping to 1. Same shape as maxChars
    // on url-extract; a caller who wants one result asks for one.
    expect((await bodyOf({ query: "q", maxResults: "0" })).max_results).toBe(5);
    expect((await bodyOf({ query: "q", maxResults: "abc" })).max_results).toBe(5);
    expect((await bodyOf({ query: "q", maxResults: "" })).max_results).toBe(5);
  });

  it("only ever buys the 1-credit depth", async () => {
    expect((await bodyOf({ query: "q" })).search_depth).toBe("basic");
    // Even if a caller asks for more, we never spend the 2-credit depth.
    expect((await bodyOf({ query: "q", searchDepth: "advanced" })).search_depth).toBe("basic");
  });

  it("includes the answer by default and honours an explicit opt-out", async () => {
    expect((await bodyOf({ query: "q" })).include_answer).toBe(true);
    expect((await bodyOf({ query: "q", includeAnswer: "false" })).include_answer).toBe(false);
    expect((await bodyOf({ query: "q", includeAnswer: "0" })).include_answer).toBe(false);
    expect((await bodyOf({ query: "q", includeAnswer: "true" })).include_answer).toBe(true);
  });
});

describe("webSearch response", () => {
  it("renames content to snippet and rounds the score", async () => {
    vi.stubGlobal("fetch", async () => upstreamOk());
    const out = (await webSearch({ query: "q" })) as {
      results: Array<{ title: string; url: string; snippet: string; score: number }>;
      resultCount: number;
      answer: string;
      upstreamMs: number;
      checkedAt: string;
    };
    expect(out.results[0]).toEqual({ title: "T", url: "https://e.com", snippet: "snippet", score: 0.7922 });
    expect(out.resultCount).toBe(1);
    expect(out.answer).toBe("an answer");
    expect(out.upstreamMs).toBe(1130);
    expect(out.checkedAt).toBeTruthy();
  });

  it("survives an upstream that omits every optional field", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}] }),
    }));
    const out = (await webSearch({ query: "q" })) as {
      results: Array<{ title: null; url: null; snippet: null; score: null }>;
      answer: null;
      upstreamMs: null;
    };
    expect(out.results[0]).toEqual({ title: null, url: null, snippet: null, score: null });
    expect(out.answer).toBeNull();
    expect(out.upstreamMs).toBeNull();
  });
});
