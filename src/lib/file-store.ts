/**
 * Agent file slots — a place for an agent to put a file, and a URL to fetch it back.
 *
 * WHY THIS ONE: measuring the x402 index by real paying wallets, the single
 * best-earning endpoint on the whole network that has no metered upstream under
 * it is "give me somewhere to upload a file" — one seller reaches ~110 distinct
 * payers from that alone. Agents produce artifacts (a report, a chart, a CSV, a
 * build) and have nowhere to put them: a serverless runtime has no disk, and an
 * MCP client cannot hand a blob back to a user. Storage is a fraction of a cent
 * at agent file sizes, so unlike search or enrichment the margin is ours.
 *
 * HOW IT AVOIDS COSTING US ANYTHING PER CALL: the bytes never pass through this
 * function. We sign a URL and the agent PUTs straight to the bucket, so a paid
 * call is a signature — no bandwidth, no timeout risk, no size limit imposed by
 * the runtime. Same reason the retrieval URL is signed rather than proxied.
 *
 * SigV4 is hand-rolled here for the same reason the payment adapters are: it is
 * one HMAC chain against a documented spec, and it keeps a storage SDK (and its
 * dependency tree) out of a codebase that mints balances. It is verified against
 * AWS's own published test vector in the tests.
 */

import "server-only";
import { createHash, createHmac } from "node:crypto";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — an agent artifact, not a video
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;
const DEFAULT_TTL_DAYS = 7;
const UPLOAD_WINDOW_S = 15 * 60; // the agent should upload now, not next week
/** SigV4 will not sign a URL for longer than this, whatever the retention is. */
const MAX_PRESIGN_S = 7 * 24 * 60 * 60;

export interface S3Config {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL, when the bucket is served on one (r2.dev or a custom
   *  domain). Without it, retrieval falls back to a signed URL. */
  publicBase?: string;
}

/** Configuration, or null when the operator has not connected a bucket. */
export function s3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT?.replace(/\/$/, "");
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION || "auto",
    publicBase: process.env.S3_PUBLIC_BASE?.replace(/\/$/, "") || undefined,
  };
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding. S3 signs paths with `/` intact and everything else escaped. */
function uriEncode(s: string, encodeSlash: boolean): string {
  return s
    .split("")
    .map((c) => {
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      if (c === "/") return encodeSlash ? "%2F" : "/";
      return Array.from(Buffer.from(c, "utf8"))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

/**
 * A presigned S3 URL (query-string auth, SigV4).
 *
 * `now` and `extraSignedHeaders` are parameters rather than ambient state so the
 * whole thing can be checked against AWS's published example, which is the only
 * way to know a signature implementation is right before a bucket rejects it.
 */
export function presign(opts: {
  cfg: S3Config;
  method: "GET" | "PUT";
  key: string;
  expiresIn: number;
  now?: Date;
  /** Headers that must be signed (and therefore sent) with the request. */
  extraSignedHeaders?: Record<string, string>;
  /**
   * Where the bucket name goes. R2 and most S3-compatible endpoints take it in
   * the path; AWS's own worked example (and S3 proper) puts it in the hostname,
   * and the two produce different signatures because the canonical path differs.
   */
  style?: "path" | "virtual";
}): string {
  const { cfg, method, key, expiresIn } = opts;
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20130524T000000Z
  const dateStamp = amzDate.slice(0, 8);
  const cleanKey = key.replace(/^\/+/, "");
  const style = opts.style ?? (process.env.S3_URL_STYLE === "virtual" ? "virtual" : "path");
  const endpointHost = new URL(cfg.endpoint).host;
  const url =
    style === "virtual"
      ? new URL(`${new URL(cfg.endpoint).protocol}//${cfg.bucket}.${endpointHost}/${cleanKey}`)
      : new URL(`${cfg.endpoint}/${cfg.bucket}/${cleanKey}`);
  const host = url.host;

  const headers: Record<string, string> = { host, ...(opts.extraSignedHeaders ?? {}) };
  const sortedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.min(expiresIn, MAX_PRESIGN_S)),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join("&");

  const canonicalRequest = [
    method,
    uriEncode(url.pathname, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return `${url.origin}${uriEncode(url.pathname, false)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * A safe object key from whatever the caller called their file.
 *
 * The name is a hint, never a path: a caller-supplied key is how one agent
 * overwrites another's file, or writes outside its prefix.
 */
export function safeName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    // Drop the combining marks NFKD just split off, so "ödeme" becomes "odeme"
    // rather than "o-deme".
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 80);
  return cleaned || "file";
}

/** A key nobody can guess, so an unlisted bucket URL is not enumerable. */
function objectKey(name: string, ttlDays: number): string {
  const rand = createHash("sha256")
    .update(`${Date.now()}:${Math.random()}:${name}`)
    .digest("hex")
    .slice(0, 24);
  // Prefixed by retention so a bucket lifecycle rule can expire each class.
  return `agent/${ttlDays}d/${rand}/${name}`;
}

export async function fileSlot(params: Record<string, string>) {
  const cfg = s3Config();
  // Fail closed: never take money for a slot we cannot actually issue.
  if (!cfg) {
    const err = new Error("File storage is not configured on this deployment");
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  const bytes = Number(params.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error("Missing 'bytes' — declare the exact size of the file you are about to upload");
  }
  if (bytes > MAX_BYTES) {
    throw new Error(`File too large: ${bytes} bytes, limit is ${MAX_BYTES} (25 MB)`);
  }

  // A supplied-but-out-of-range ttl is clamped, not silently swapped for the
  // default: asking for 0 days and getting 7 is a surprise, asking for 0 and
  // getting the 1-day minimum is the nearest thing we can actually do.
  const askedTtl = Number(params.ttlDays);
  const ttlDays = Number.isFinite(askedTtl) && params.ttlDays !== undefined && params.ttlDays !== ""
    ? Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, Math.round(askedTtl)))
    : DEFAULT_TTL_DAYS;
  const name = safeName(params.name);
  const contentType = (params.contentType || "application/octet-stream").slice(0, 120);
  const key = objectKey(name, ttlDays);
  const now = new Date();

  // The size is SIGNED, not merely suggested: the upload fails unless it is
  // exactly the number of bytes that were paid for. Without this the slot is an
  // open door to our storage bill.
  const uploadUrl = presign({
    cfg,
    method: "PUT",
    key,
    expiresIn: UPLOAD_WINDOW_S,
    now,
    extraSignedHeaders: { "content-length": String(bytes), "content-type": contentType },
  });

  const retrievalSeconds = Math.min(ttlDays * 86_400, MAX_PRESIGN_S);
  const publicUrl = cfg.publicBase
    ? `${cfg.publicBase}/${key}`
    : presign({ cfg, method: "GET", key, expiresIn: retrievalSeconds, now });

  return {
    key,
    upload: {
      url: uploadUrl,
      method: "PUT",
      // Both are signed — sending different ones invalidates the signature.
      headers: { "content-length": String(bytes), "content-type": contentType },
      expiresAt: new Date(now.getTime() + UPLOAD_WINDOW_S * 1000).toISOString(),
      note: "PUT the file body to this URL with exactly these headers. The bytes go straight to storage — they do not pass through this API.",
    },
    retrieval: {
      url: publicUrl,
      signed: !cfg.publicBase,
      expiresAt: cfg.publicBase
        ? new Date(now.getTime() + ttlDays * 86_400_000).toISOString()
        : new Date(now.getTime() + retrievalSeconds * 1000).toISOString(),
    },
    bytes,
    contentType,
    ttlDays,
    checkedAt: now.toISOString(),
    guidance:
      "Upload within the 15-minute window, then hand the retrieval URL to whoever needs the file. Anyone holding that URL can read it, so treat it as the credential it is.",
    limits: {
      maxBytes: MAX_BYTES,
      uploadWindowSeconds: UPLOAD_WINDOW_S,
      retentionDays: `${MIN_TTL_DAYS}-${MAX_TTL_DAYS}`,
      signedRetrievalMaxDays: MAX_PRESIGN_S / 86_400,
    },
    disclaimer:
      "Retention is enforced by the bucket's lifecycle policy, not by this call: the object is scheduled to expire after the requested window, and is not guaranteed to survive it. Keep your own copy of anything you cannot regenerate. Uploads are not scanned or validated.",
  };
}
