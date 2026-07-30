import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * This endpoint fetches whatever URL a stranger hands it, so the tests that
 * matter are the ones that keep it from becoming an open proxy into our network:
 * private targets refused, and — the easy one to get wrong — refused again on
 * every redirect hop, not just the first.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { htmlToText, fetchPage } from "@/lib/web-fetch";

const PUBLIC_IP = [{ address: "93.184.216.34", family: 4 }];
const PRIVATE_IP = [{ address: "169.254.169.254", family: 4 }];

function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

describe("htmlToText", () => {
  it("drops script and style bodies instead of leaking them as text", () => {
    const out = htmlToText(
      `<html><head><style>.a{color:red}</style><script>var secret=1;alert("x")</script></head>
       <body><p>Real prose here.</p></body></html>`,
    );
    expect(out).toContain("Real prose here.");
    expect(out).not.toMatch(/secret|alert|color:red/);
  });

  it("prefers the article region over page furniture", () => {
    const filler = "The actual story. ".repeat(40);
    const out = htmlToText(
      `<body><nav>Home About Login</nav><article><p>${filler}</p></article><footer>© 2026 Corp</footer></body>`,
    );
    expect(out).toContain("The actual story.");
    expect(out).not.toContain("Home About Login");
    expect(out).not.toContain("© 2026 Corp");
  });

  it("strips nav/footer when the page marks no article region", () => {
    const out = htmlToText(`<body><nav>Menu</nav><p>Body copy.</p><footer>Legal</footer></body>`);
    expect(out).toContain("Body copy.");
    expect(out).not.toContain("Menu");
    expect(out).not.toContain("Legal");
  });

  it("keeps paragraphs apart rather than running words together", () => {
    const out = htmlToText("<body><p>First para</p><p>Second para</p></body>");
    expect(out).toBe("First para\nSecond para");
  });

  it("decodes the entities that appear in real prose", () => {
    const out = htmlToText("<body><p>Tom&#39;s &amp; Jerry&nbsp;&mdash; 5 &lt; 10</p></body>");
    expect(out).toBe("Tom's & Jerry — 5 < 10");
  });

  it("returns empty for a page with no prose", () => {
    expect(htmlToText("<body><script>app()</script></body>")).toBe("");
  });
});

describe("fetchPage — SSRF", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    lookupMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses plain http", async () => {
    await expect(fetchPage("http://example.com")).rejects.toThrow(/https/i);
  });

  it("refuses localhost", async () => {
    await expect(fetchPage("https://localhost/x")).rejects.toThrow(/not allowed/i);
  });

  it("refuses a private IP literal", async () => {
    await expect(fetchPage("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private/i);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue(PRIVATE_IP);
    await expect(fetchPage("https://evil.example")).rejects.toThrow(/private/i);
  });

  it("refuses a REDIRECT into a private address after a public first hop", async () => {
    // The bug this guards: validating only the URL the caller passed.
    lookupMock.mockImplementation(async (host: string) =>
      host === "public.example" ? PUBLIC_IP : PRIVATE_IP,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://internal.example/" } })),
    );
    await expect(fetchPage("https://public.example")).rejects.toThrow(/private/i);
  });

  it("stops after too many redirects", async () => {
    lookupMock.mockResolvedValue(PUBLIC_IP);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 301, headers: { location: "https://public.example/next" } })),
    );
    await expect(fetchPage("https://public.example")).rejects.toThrow(/too many redirects/i);
  });
});

describe("fetchPage — responses", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue(PUBLIC_IP);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("extracts text and metadata from a normal page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        htmlResponse(
          `<html><head><title>Ship it</title>
             <meta name="description" content="A short summary">
             <meta property="og:site_name" content="Example News"></head>
             <body><article><p>${"Long enough body copy. ".repeat(30)}</p></article></body></html>`,
        ),
      ),
    );
    const page = await fetchPage("https://public.example/post");
    expect(page.title).toBe("Ship it");
    expect(page.description).toBe("A short summary");
    expect(page.siteName).toBe("Example News");
    expect(page.text).toContain("Long enough body copy.");
    expect(page.words).toBeGreaterThan(50);
    expect(page.status).toBe(200);
  });

  it("accepts a bare domain the way a person types it", async () => {
    const spy = vi.fn(async () => htmlResponse("<body><p>hi there friend</p></body>"));
    vi.stubGlobal("fetch", spy);
    const page = await fetchPage("example.com");
    expect(page.finalUrl).toMatch(/^https:\/\/example\.com/);
  });

  it("surfaces an upstream error status instead of billing for it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("nope", { status: 404 })));
    await expect(fetchPage("https://public.example/missing")).rejects.toThrow(/HTTP 404/);
  });

  it("refuses binary content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } })),
    );
    await expect(fetchPage("https://public.example/doc.pdf")).rejects.toThrow(/content type/i);
  });

  it("clips to maxChars and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(`<body><p>${"x".repeat(5000)}</p></body>`)));
    const page = await fetchPage("https://public.example", 1000);
    expect(page.chars).toBe(1000);
    expect(page.truncated).toBe(true);
  });

  it("follows a redirect to a public host and reports the final URL", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        return call === 1
          ? new Response(null, { status: 301, headers: { location: "https://public.example/final" } })
          : htmlResponse("<body><p>arrived at the destination</p></body>");
      }),
    );
    const page = await fetchPage("https://public.example/start");
    expect(page.finalUrl).toBe("https://public.example/final");
    expect(page.redirects).toBe(1);
    expect(page.text).toContain("arrived");
  });
});

/**
 * The rule that keeps us from selling furniture: a large HTML shell yielding
 * almost no prose is a client-rendered app, and the buyer must not be charged
 * for its nav links. A genuinely short page has to stay allowed.
 */
describe("urlExtract — refuses pages it couldn't really read", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue(PUBLIC_IP);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a big JS shell with only chrome in it", async () => {
    const { urlExtract } = await import("@/lib/web-services");
    const shell = `<body><nav>Home</nav><div>${"<script>x()</script>".repeat(4000)}</div><p>Sign in</p></body>`;
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(shell)));
    await expect(urlExtract({ url: "https://public.example" })).rejects.toThrow(/renders its content in the browser/i);
  });

  it("still serves a genuinely short page", async () => {
    const { urlExtract } = await import("@/lib/web-services");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse("<body><p>This domain is for use in documentation examples.</p></body>")),
    );
    const r = (await urlExtract({ url: "https://public.example" })) as { words: number };
    expect(r.words).toBeGreaterThan(5);
  });

  it("refuses a page with no text at all", async () => {
    const { urlExtract } = await import("@/lib/web-services");
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<body><script>app()</script></body>")));
    await expect(urlExtract({ url: "https://public.example" })).rejects.toThrow(/no readable text/i);
  });
})
