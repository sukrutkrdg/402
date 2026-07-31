/**
 * Publish a page — Markdown or HTML in, a shareable URL out.
 *
 * WHY, on top of file-slot: a slot is for bytes an agent will fetch back itself.
 * This is for the other half of the job — the agent has written a report and a
 * human needs to look at it. That means a real HTML document with a content type
 * a browser will render, not a download.
 *
 * WHERE IT IS SERVED FROM, and why that matters: the page goes to the object
 * bucket, never to 402.com.tr. Caller-supplied HTML served from our own origin
 * would run with our cookies and our domain's trust; on a separate storage
 * origin it can only affect itself. That is a deliberate boundary, not an
 * accident of deployment, so it is documented in the response.
 */

import "server-only";
import { s3Config, presign, safeName } from "./file-store";
import { markdownToHtml } from "./file-convert";

// Matches the gateway's own ceiling for text params (~45K, about 7,000 words —
// a long report). Promising more here would just be truncated upstream, which is
// the kind of silent lie this codebase keeps hunting down; anything bigger
// belongs in a file slot.
const MAX_CHARS = 45_000;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;
const DEFAULT_TTL_DAYS = 7;
const MAX_PRESIGN_S = 7 * 24 * 60 * 60;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Wrap rendered body HTML in a complete, readable document.
 *
 * Styling is inline and minimal: an agent's report should be legible on a phone
 * without us shipping a stylesheet the caller cannot change. No script tags, no
 * external requests — the page must render with the network unplugged.
 */
export function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
h1,h2,h3,h4{line-height:1.25;margin:1.8em 0 .6em}
h1{margin-top:0}
pre{overflow-x:auto;padding:.9rem;border-radius:.5rem;background:rgba(127,127,127,.14)}
code{font:.92em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre code{background:none;padding:0}
:not(pre)>code{background:rgba(127,127,127,.14);padding:.15em .35em;border-radius:.3em}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}
th,td{border:1px solid rgba(127,127,127,.35);padding:.45rem .6rem;text-align:left}
blockquote{margin:1em 0;padding:.1rem 1rem;border-left:3px solid rgba(127,127,127,.4);opacity:.85}
img{max-width:100%;height:auto}
hr{border:none;border-top:1px solid rgba(127,127,127,.3);margin:2rem 0}
a{color:inherit}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export async function filePublish(params: Record<string, string>) {
  const cfg = s3Config();
  if (!cfg) {
    const err = new Error("File storage is not configured on this deployment");
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  const content = params.text ?? params.content ?? "";
  if (!content.trim()) throw new Error("Missing 'text' — pass the Markdown or HTML to publish");
  if (content.length > MAX_CHARS) {
    throw new Error(`Content too large: ${content.length} characters, limit is ${MAX_CHARS}. Use file-slot for large files.`);
  }

  const format = (params.format || "md").toLowerCase();
  if (format !== "md" && format !== "html") throw new Error("'format' must be 'md' (default) or 'html'");

  const askedTtl = Number(params.ttlDays);
  const ttlDays =
    Number.isFinite(askedTtl) && params.ttlDays !== undefined && params.ttlDays !== ""
      ? Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, Math.round(askedTtl)))
      : DEFAULT_TTL_DAYS;

  const title = (params.title || "").trim().slice(0, 200) || "Agent report";
  // Markdown is rendered by us (escaped first, so it cannot inject). Raw HTML is
  // the caller's own document, published as-is on the storage origin.
  const body = format === "md" ? markdownToHtml(content) : content;
  const html = params.bare === "true" && format === "html" ? content : pageShell(title, body);
  const bytes = Buffer.byteLength(html, "utf8");

  const slug = safeName(params.name || `${title}.html`).replace(/\.html?$/i, "");
  const key = `agent/${ttlDays}d/${Buffer.from(crypto.randomUUID()).toString("hex").slice(0, 24)}/${slug}.html`;
  const now = new Date();

  const putUrl = presign({
    cfg,
    method: "PUT",
    key,
    expiresIn: 300,
    now,
    extraSignedHeaders: { "content-length": String(bytes), "content-type": "text/html; charset=utf-8" },
  });

  // Unlike file-slot, we do the upload: the caller sent us the content, so
  // handing back an upload URL would make them do a second round trip for bytes
  // we already hold.
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "content-length": String(bytes), "content-type": "text/html; charset=utf-8" },
    body: html,
  });
  if (!res.ok) {
    throw new Error(`Storage rejected the upload (${res.status})`);
  }

  const retrievalSeconds = Math.min(ttlDays * 86_400, MAX_PRESIGN_S);
  const url = cfg.publicBase
    ? `${cfg.publicBase}/${key}`
    : presign({ cfg, method: "GET", key, expiresIn: retrievalSeconds, now });

  return {
    url,
    key,
    title,
    format,
    bytes,
    ttlDays,
    signed: !cfg.publicBase,
    expiresAt: cfg.publicBase
      ? new Date(now.getTime() + ttlDays * 86_400_000).toISOString()
      : new Date(now.getTime() + retrievalSeconds * 1000).toISOString(),
    checkedAt: now.toISOString(),
    guidance:
      "The page is live at that URL — hand it to whoever needs to read it. Anyone with the link can open it, so treat the link as the access control it is.",
    method:
      "Rendered and stored as a complete HTML document with no scripts and no external requests. Markdown is HTML-escaped before rendering, and only http(s) links survive.",
    disclaimer:
      "Published on the object-storage origin, never on 402.com.tr: caller-supplied HTML must not run on our domain. The page is marked noindex, and it stops being served when the retention window ends — keep your own copy of anything you cannot regenerate.",
  };
}
