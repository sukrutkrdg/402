/**
 * What a paid call actually costs — the one price function every caller reads.
 *
 * Lived inside the x402 route until workflows needed to quote a multi-step run
 * before charging any of it. A route file may only export route handlers, so a
 * quote computed anywhere else would have meant a second copy of these rules —
 * exactly the drift this function exists to prevent (see effectivePriceFor).
 * The route, its credit rail and the workflow quote all import it from here.
 */

import type { NextRequest } from "next/server";
import type { ServiceDef } from "@/lib/catalog/types";
import { kvGet } from "@/lib/kv";
import { srcHash } from "@/lib/usage";
import { clientIp } from "@/lib/rate-limit";
import { tierPrice } from "@/lib/credits";
import { translateIsLong } from "@/lib/ai";
import { exaWantsText, exaContentsIsBatch } from "@/lib/exa";

/** The AI-report price for a caller holding an unexpired entry-check coupon. */
export const COUPON_PRICE = "$0.05";

export function paramsFrom(request: Request, service: ServiceDef) {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const p of service.params) {
    const v = url.searchParams.get(p.name);
    // Defensive ceiling. Most params are short (addresses etc.) so 2000 is plenty,
    // but the text-AI services legitimately take large inputs — text/texts/text1..N
    // up to ~16K each (ai-extract-batch joins up to ~40K). Those params get a wider
    // cap so the handler's own clamp (16K/6K) is the real limit, not this slice.
    // Without this the paid AI tools silently processed only the first 2000 chars.
    if (v) {
      // `input` is hash's payload — truncating it would bill a hash of the wrong bytes.
      const wide = /^(text(s|\d+)?|input)$/i.test(p.name);
      params[p.name] = v.slice(0, wide ? 45000 : 2000);
    }
  }
  return params;
}

/**
 * What this call actually costs, for BOTH rails.
 *
 * This exists because the two rails computed it separately and drifted. When
 * `url-to-json` was split by mode — $0.01 for a default extraction, $0.06 for
 * `list=true`, whose 8000-token budget costs us ~$0.044 in model spend — the
 * uplift was added to the x402 challenge only. The credit rail kept debiting the
 * declared $0.01, so a prepaid caller bought the expensive mode for a sixth of
 * its price and the response cheerfully reported `chargedUsd: 0.01`. A $0.25
 * credit pack was worth about $1.10 of Anthropic spend to anyone who noticed.
 *
 * One function, every caller. A future price rule added here cannot reach one
 * rail and miss the other.
 */
export async function effectivePriceFor(service: ServiceDef, req: NextRequest): Promise<string> {
  if (service.id === "buy-credits") {
    // The challenge amount is the chosen pack's price (tier=0.25|1|5|20).
    return tierPrice(paramsFrom(req, service).tier || "");
  }
  if (service.id === "url-to-json") {
    const list = String(paramsFrom(req, service).list ?? "").trim();
    // Must stay identical to the listMode test in src/lib/ai.ts.
    if (/^(true|1|yes)$/i.test(list)) return "$0.06";
    return service.price;
  }
  if (service.id === "exa-contents") {
    // Exa bills contents per PAGE, so the caller picks the cost. One page is the
    // declared price; a batch is its own product. Same rule, same place.
    // `urls` is the only name declared on the service, so it is the only one
    // paramsFrom can return — the handler's `url` alias is for the MCP and
    // internal callers that pass params directly, and cannot arrive here.
    if (exaContentsIsBatch(String(paramsFrom(req, service).urls ?? ""))) return "$0.008";
    return service.price;
  }
  if (service.id === "exa-search") {
    // Highlights bill $1/1k per page on top of the search, so the tier that asks
    // for them pays for them. The test lives in exa.ts for the same reason the
    // translate one does: one place decides, both rails read it.
    if (exaWantsText(String(paramsFrom(req, service).text ?? ""))) return "$0.03";
    return service.price;
  }
  if (service.id === "ai-translate") {
    // Priced by how much output the request can demand, not by what a typical
    // one uses. The split itself lives in ai.ts so the handler and the price
    // cannot disagree about which tier a call is in.
    if (translateIsLong(String(paramsFrom(req, service).text ?? ""))) return "$0.08";
    return service.price;
  }
  if (service.id === "ai-token-report") {
    // Coupon-discounted: a caller who just paid the entry check on this token
    // gets the report for less. Falls back to full price if absent — never
    // cheaper without a real prior purchase.
    try {
      const addr = String(paramsFrom(req, service).address ?? "").toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(addr) && (await kvGet(`coupon:${srcHash(clientIp(req))}:${addr}`))) {
        return COUPON_PRICE;
      }
    } catch {
      /* fall back to full price */
    }
  }
  return service.price;
}
