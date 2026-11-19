import { kvGet, kvSet, kvSoftBudgetExceeded } from "@/lib/kv";
import { tokenVerdict } from "@/lib/token-verdict";

/**
 * Embeddable SVG verdict badge. A platform drops one line next to any Base token:
 *
 *   <img src="https://402.com.tr/embed/badge?address=0x…" alt="token-verdict">
 *
 * It shows the live SAFE / CAUTION / AVOID verdict. The verdict is cached per
 * token in KV for 10 minutes (and at the CDN), so badge <img> traffic can't run
 * the paid safety stack more than ~6×/hour per token; when the KV budget is
 * exhausted it serves UNKNOWN rather than computing. No payment, no abuse surface.
 */
export const dynamic = "force-dynamic";

type Verdict = "SAFE" | "CAUTION" | "AVOID" | "UNKNOWN";
const COLOR: Record<Verdict, string> = {
  SAFE: "#16c784",
  CAUTION: "#f5a623",
  AVOID: "#ff4d4f",
  UNKNOWN: "#8b95a7",
};
const CACHE_TTL = 600;

function esc(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[c] ?? c,
  );
}

function badgeSvg(label: string, value: string, color: string): string {
  const lw = Math.round(label.length * 6.2) + 14;
  const vw = Math.round(value.length * 6.8) + 18;
  const w = lw + vw;
  const h = 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<clipPath id="r"><rect width="${w}" height="${h}" rx="4"/></clipPath>
<g clip-path="url(#r)">
<rect width="${w}" height="${h}" fill="#07080a"/>
<rect x="${lw}" width="${vw}" height="${h}" fill="${color}"/>
</g>
<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#cdd5e0" text-anchor="middle">${esc(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#07080a" font-weight="bold" text-anchor="middle">${esc(value)}</text>
</g>
</svg>`;
}

export async function GET(req: Request): Promise<Response> {
  const addr = (new URL(req.url).searchParams.get("address") || "").trim();
  let verdict: Verdict = "UNKNOWN";

  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    const key = `embed:verdict:${addr.toLowerCase()}`;
    try {
      const cached = await kvGet(key);
      if (cached) {
        verdict = (cached.split("|")[0] as Verdict) || "UNKNOWN";
      } else if (!kvSoftBudgetExceeded()) {
        const r = await tokenVerdict({ address: addr });
        verdict = (r.verdict as Verdict) ?? "UNKNOWN";
        await kvSet(key, `${verdict}|${r.confidence ?? ""}`, CACHE_TTL).catch(() => {});
      }
    } catch {
      verdict = "UNKNOWN";
    }
  }

  return new Response(badgeSvg("token-verdict", verdict, COLOR[verdict]), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=600, stale-while-revalidate=86400",
    },
  });
}
