import { describe, it, expect } from "vitest";
import { parseDelimited, delimitedToJson, jsonToDelimited, markdownToHtml, fileConvert } from "@/lib/file-convert";
import { pageShell } from "@/lib/file-publish";

describe("parseDelimited — the cases a naive splitter gets wrong", () => {
  it("keeps separators that live inside quotes", () => {
    expect(parseDelimited('a,b\n"Ankara, Türkiye",2', ",")).toEqual([
      ["a", "b"],
      ["Ankara, Türkiye", "2"],
    ]);
  });

  it("keeps newlines inside quotes as part of the field", () => {
    expect(parseDelimited('note,n\n"line one\nline two",5', ",")).toEqual([
      ["note", "n"],
      ["line one\nline two", "5"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseDelimited('q\n"she said ""hi"""', ",")).toEqual([["q"], ['she said "hi"']]);
  });

  it("handles CRLF and a trailing newline without inventing an empty row", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields, including at the end of a row", () => {
    expect(parseDelimited("a,b,c\n1,,3\n4,5,", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["4", "5", ""],
    ]);
  });

  it("reads tabs when asked to", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("delimitedToJson", () => {
  it("types numbers and booleans but leaves identifiers alone", () => {
    const [row] = delimitedToJson("id,qty,ok,zip\nA-1,42,true,01234", ",", true);
    expect(row).toEqual({ id: "A-1", qty: 42, ok: true, zip: "01234" });
  });

  it("keeps everything as text when typing is off", () => {
    const [row] = delimitedToJson("qty\n42", ",", false);
    expect(row).toEqual({ qty: "42" });
  });

  it("names unnamed columns rather than colliding on empty keys", () => {
    const [row] = delimitedToJson("a,,c\n1,2,3", ",", true);
    expect(Object.keys(row)).toEqual(["a", "column_2", "c"]);
  });
});

describe("jsonToDelimited", () => {
  it("uses the union of keys so a sparse row does not shift columns", () => {
    const csv = jsonToDelimited([{ a: 1, b: 2 }, { a: 3, c: 4 }], ",");
    expect(csv).toBe("a,b,c\n1,2,\n3,,4");
  });

  it("quotes only what has to be quoted", () => {
    const csv = jsonToDelimited([{ plain: "x", comma: "a,b", quote: 'he said "no"', nl: "one\ntwo" }], ",");
    // Compared whole: splitting on "\n" would cut the row apart at the very
    // embedded newline this test exists to check.
    expect(csv).toBe('plain,comma,quote,nl\nx,"a,b","he said ""no""","one\ntwo"');
  });
});

describe("markdownToHtml", () => {
  it("renders the blocks an agent report is made of", () => {
    const html = markdownToHtml("# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  it("renders tables", () => {
    const html = markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  /**
   * This output is served to a browser. A converter that passes raw HTML through
   * is a stored-XSS generator with a price on it, so the escaping is the feature.
   */
  it("cannot be used to inject script", () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
    // The dangerous strings may appear — but only as escaped text a browser
    // renders, never as tags it executes.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
  });

  it("drops javascript: and data: links, keeps http(s)", () => {
    const html = markdownToHtml("[safe](https://example.com) [bad](javascript:alert(1))");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("bad");
  });
});

describe("fileConvert", () => {
  it("rejects anything it cannot actually do", async () => {
    await expect(fileConvert({ text: "a", from: "csv", to: "pdf" })).rejects.toThrow(/one of/i);
    await expect(fileConvert({ text: "a", from: "csv", to: "csv" })).rejects.toThrow(/same/i);
    await expect(fileConvert({ text: "a", from: "html", to: "json" })).rejects.toThrow(/Unsupported/i);
    await expect(fileConvert({ text: "", from: "csv", to: "json" })).rejects.toThrow(/Missing 'text'/i);
  });

  it("says what is wrong with malformed JSON instead of returning nothing", async () => {
    await expect(fileConvert({ text: "{not json", from: "json", to: "csv" })).rejects.toThrow(/not valid JSON/i);
  });

  it("round-trips csv → json → csv", async () => {
    const csv = "name,qty\nWidget,3\n\"Bolt, hex\",12";
    const toJson = await fileConvert({ text: csv, from: "csv", to: "json" });
    expect(toJson.rows).toBe(2);
    const back = await fileConvert({ text: toJson.output, from: "json", to: "csv" });
    expect(back.output).toBe(csv);
  });

  it("makes a markdown table out of a csv", async () => {
    const r = await fileConvert({ text: "a,b\n1,2", from: "csv", to: "md" });
    expect(r.output).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("refuses an input larger than it will parse", async () => {
    await expect(fileConvert({ text: "x".repeat(200_001), from: "csv", to: "json" })).rejects.toThrow(/too large/i);
  });
});

describe("pageShell", () => {
  it("escapes the title and ships no scripts or external requests", () => {
    const html = pageShell('</title><script>alert(1)</script>', "<p>hi</p>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/title&gt;");
    expect(html).not.toMatch(/https?:\/\//); // nothing to fetch from the network
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});
