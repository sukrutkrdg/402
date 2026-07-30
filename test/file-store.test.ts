import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { presign, safeName, fileSlot, type S3Config } from "@/lib/file-store";

/**
 * A signature implementation is either exactly right or useless, and "the bucket
 * rejected it" is a terrible way to find out. AWS publishes a worked SigV4
 * example for a presigned GET; this pins ours to it.
 *
 * Source: AWS SigV4 documentation, "Example: signature calculation for a
 * presigned URL" — GET examplebucket/test.txt, us-east-1, 20130524T000000Z,
 * expires 86400.
 */
const AWS_EXAMPLE: S3Config = {
  endpoint: "https://s3.amazonaws.com",
  bucket: "examplebucket",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("presign — against AWS's published example", () => {
  it("produces the documented signature", () => {
    const url = presign({
      cfg: AWS_EXAMPLE,
      method: "GET",
      key: "test.txt",
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
      style: "virtual", // the example is virtual-hosted: examplebucket.s3.amazonaws.com/test.txt
    });
    const sig = new URL(url).searchParams.get("X-Amz-Signature");
    expect(sig).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs the pieces a bucket will check", () => {
    const url = new URL(
      presign({
        cfg: AWS_EXAMPLE,
        method: "GET",
        key: "test.txt",
        expiresIn: 86400,
        now: new Date("2013-05-24T00:00:00Z"),
        style: "virtual",
      }),
    );
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("never signs for longer than SigV4 allows, whatever it is asked for", () => {
    const url = new URL(
      presign({ cfg: AWS_EXAMPLE, method: "GET", key: "x", expiresIn: 99_999_999, now: new Date("2013-05-24T00:00:00Z") }),
    );
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(7 * 24 * 60 * 60);
  });

  it("changes the signature when any signed input changes", () => {
    const base = { cfg: AWS_EXAMPLE, key: "test.txt", expiresIn: 3600, now: new Date("2013-05-24T00:00:00Z") } as const;
    const get = presign({ ...base, method: "GET" });
    const put = presign({ ...base, method: "PUT" });
    const sized = presign({ ...base, method: "PUT", extraSignedHeaders: { "content-length": "10" } });
    const sizedDifferently = presign({ ...base, method: "PUT", extraSignedHeaders: { "content-length": "11" } });
    const sigs = [get, put, sized, sizedDifferently].map((u) => new URL(u).searchParams.get("X-Amz-Signature"));
    expect(new Set(sigs).size).toBe(4);
    // The size is part of the signature, which is what stops a paid 10-byte slot
    // from being used to upload a gigabyte.
    expect(new URL(sized).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
  });
});

describe("safeName", () => {
  it("treats the caller's name as a hint, never a path", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(safeName("/absolute/key")).toBe("key");
  });

  it("keeps something readable out of anything", () => {
    expect(safeName("Quarterly Report (final).csv")).toBe("Quarterly-Report-final-.csv");
    expect(safeName("")).toBe("file");
    expect(safeName("...")).toBe("file");
    expect(safeName("ödeme raporu.json")).toBe("odeme-raporu.json");
    expect(safeName("a".repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe("fileSlot", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
    process.env.S3_BUCKET = "agent-files";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    delete process.env.S3_PUBLIC_BASE;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("refuses to sell a slot it cannot issue", async () => {
    delete process.env.S3_ACCESS_KEY_ID;
    await expect(fileSlot({ bytes: "100" })).rejects.toThrow(/not configured/i);
  });

  it("requires the caller to declare the size, so the signature can pin it", async () => {
    await expect(fileSlot({})).rejects.toThrow(/bytes/i);
    await expect(fileSlot({ bytes: "0" })).rejects.toThrow(/bytes/i);
    await expect(fileSlot({ bytes: "not-a-number" })).rejects.toThrow(/bytes/i);
    await expect(fileSlot({ bytes: String(26 * 1024 * 1024) })).rejects.toThrow(/too large/i);
  });

  it("issues an upload URL whose size and type are part of the signature", async () => {
    const r = await fileSlot({ bytes: "1234", contentType: "text/csv", name: "report.csv" });
    const u = new URL(r.upload.url);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(r.upload.headers["content-length"]).toBe("1234");
    expect(r.upload.headers["content-type"]).toBe("text/csv");
    expect(r.key).toMatch(/^agent\/7d\/[0-9a-f]{24}\/report\.csv$/);
  });

  it("gives two different callers two unguessable keys for the same filename", async () => {
    const a = await fileSlot({ bytes: "10", name: "out.json" });
    const b = await fileSlot({ bytes: "10", name: "out.json" });
    expect(a.key).not.toBe(b.key);
    expect(a.key.split("/")[2]).toMatch(/^[0-9a-f]{24}$/);
  });

  it("clamps retention to the supported window", async () => {
    expect((await fileSlot({ bytes: "10", ttlDays: "999" })).ttlDays).toBe(30);
    expect((await fileSlot({ bytes: "10", ttlDays: "0" })).ttlDays).toBe(1);
    expect((await fileSlot({ bytes: "10" })).ttlDays).toBe(7);
  });

  /**
   * Retention can be 30 days but a signed URL cannot: SigV4 caps at 7. Promising
   * a 30-day link that dies on day 8 would be the kind of quiet lie this codebase
   * keeps trying to avoid, so the response reports the date it will actually stop
   * working.
   */
  it("does not promise a signed retrieval URL for longer than it can sign", async () => {
    const r = await fileSlot({ bytes: "10", ttlDays: "30" });
    expect(r.retrieval.signed).toBe(true);
    const life = new Date(r.retrieval.expiresAt).getTime() - new Date(r.checkedAt).getTime();
    expect(Math.round(life / 86_400_000)).toBe(7);
    expect(r.ttlDays).toBe(30);
  });

  it("uses the public base URL when the bucket has one, and says it is unsigned", async () => {
    process.env.S3_PUBLIC_BASE = "https://files.402.com.tr";
    const r = await fileSlot({ bytes: "10", ttlDays: "30", name: "a.txt" });
    expect(r.retrieval.signed).toBe(false);
    expect(r.retrieval.url).toBe(`https://files.402.com.tr/${r.key}`);
    const life = new Date(r.retrieval.expiresAt).getTime() - new Date(r.checkedAt).getTime();
    expect(Math.round(life / 86_400_000)).toBe(30);
  });
});
