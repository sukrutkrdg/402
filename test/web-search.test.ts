import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { webSearch, webExtract, searchConfigured } from "@/lib/web-search";

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

/**
 * webExtract bills a flat price against an upstream that charges per 5 URLs, so
 * the cap and the refusals are the margin. A silently-truncated batch or a
 * charged all-failed call is money lost or trust lost.
 */
const extractOk = (results: unknown[], failed: unknown[] = []) => ({
  ok: true,
  status: 200,
  json: async () => ({ results, failed_results: failed, response_time: 0.42 }),
});
const onePage = { url: "https://a.com", title: "A", raw_content: "hello" };

describe("webExtract refusals (buyer is not charged)", () => {
  it("throws when the key is missing, before any fetch", async () => {
    delete process.env[KEY];
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(webExtract({ urls: "https://a.com" })).rejects.toThrow(/TAVILY_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws on an empty list, before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(webExtract({ urls: "  ,  , " })).rejects.toThrow(/Missing 'urls'/);
    await expect(webExtract({})).rejects.toThrow(/Missing 'urls'/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an over-cap batch instead of truncating it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const six = Array.from({ length: 6 }, (_, i) => `https://s${i}.com`).join(",");
    await expect(webExtract({ urls: six })).rejects.toThrow(/Too many URLs: 6.*up to 5/s);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not charge when every URL failed", async () => {
    vi.stubGlobal("fetch", async () => extractOk([], [{ url: "https://a.com", error: "timeout" }]));
    await expect(webExtract({ urls: "https://a.com" })).rejects.toThrow(/None of the 1 URL\(s\) could be read: timeout\. You were not charged\./);
  });

  it("surfaces the upstream status", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 432, text: async () => "out of credits" }));
    await expect(webExtract({ urls: "https://a.com" })).rejects.toThrow(/432.*out of credits/);
  });
});

describe("webExtract request and response", () => {
  it("sends exactly the URLs given, at the 1-credit depth", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return extractOk([onePage]);
    });
    await webExtract({ urls: " https://a.com , https://b.com " });
    expect(sent.urls).toEqual(["https://a.com", "https://b.com"]);
    expect(sent.extract_depth).toBe("basic");
  });

  it("accepts the singular url= alias", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return extractOk([onePage]);
    });
    await webExtract({ url: "https://a.com" });
    expect(sent.urls).toEqual(["https://a.com"]);
  });

  it("accepts exactly the cap", async () => {
    vi.stubGlobal("fetch", async () => extractOk([onePage]));
    const five = Array.from({ length: 5 }, (_, i) => `https://s${i}.com`).join(",");
    await expect(webExtract({ urls: five })).resolves.toBeTruthy();
  });

  it("reports partial success rather than hiding the failures", async () => {
    vi.stubGlobal("fetch", async () =>
      extractOk([onePage], [{ url: "https://dead.com", error: "404" }]),
    );
    const out = (await webExtract({ urls: "https://a.com,https://dead.com" })) as {
      pages: Array<{ url: string; title: string; text: string; chars: number }>;
      pageCount: number;
      failed: Array<{ url: string; error: string }>;
      requested: number;
      upstreamMs: number;
    };
    expect(out.pages[0]).toEqual({ url: "https://a.com", title: "A", text: "hello", chars: 5 });
    expect(out.pageCount).toBe(1);
    expect(out.failed).toEqual([{ url: "https://dead.com", error: "404" }]);
    expect(out.requested).toBe(2);
    expect(out.upstreamMs).toBe(420);
  });

  it("survives an upstream that omits every optional field", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}] }),
    }));
    const out = (await webExtract({ urls: "https://a.com" })) as {
      pages: Array<{ url: null; title: null; text: null; chars: number }>;
      failed: unknown[];
      upstreamMs: null;
    };
    expect(out.pages[0]).toEqual({ url: null, title: null, text: null, chars: 0 });
    expect(out.failed).toEqual([]);
    expect(out.upstreamMs).toBeNull();
  });
});
