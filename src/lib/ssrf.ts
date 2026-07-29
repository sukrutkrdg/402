/**
 * SSRF guard for caller-supplied URLs.
 *
 * Extracted from alerts.ts so the same check protects every place we fetch a
 * URL a stranger handed us — webhooks and, now, page fetching. A paid endpoint
 * that fetches arbitrary URLs is a proxy into our network unless every hop is
 * validated, so this is the one gate all of them go through.
 */

import "server-only";
import net from "node:net";
import { lookup } from "node:dns/promises";

/** True if an IP literal is in a private / loopback / link-local / metadata range. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.replace("::ffff:", "")); // IPv4-mapped
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

/**
 * Rejects URLs that could be used for SSRF: non-https, localhost/.local, private
 * IP literals, or hostnames that resolve to private addresses.
 *
 * `what` only shapes the error message so callers can say "webhook" or "url".
 * Note this must be re-run on every redirect hop: a public hostname is free to
 * 302 into the metadata service, and one check at the start would miss it.
 */
export async function assertSafeUrl(raw: string, what = "url"): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${what}: must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`Invalid ${what}: must be an https:// URL`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error(`Invalid ${what}: host not allowed`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Invalid ${what}: private/internal address not allowed`);
    return url;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`Invalid ${what}: host could not be resolved`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`Invalid ${what}: resolves to a private/internal address`);
  }
  return url;
}
