import { ImageResponse } from "next/og";
import { verdictArt, type VerdictName } from "@/lib/brand-art";

/**
 * 1200×630 shareable token-verdict card. A pure renderer: it draws the verdict
 * passed in the query string and computes nothing, so it is free to serve and
 * cannot be abused to run a paid check. token-verdict returns a `cardUrl`
 * pointing here; called with no params it shows the product itself.
 *
 *   /brand/verdict?v=SAFE&addr=0x…&conf=high&size=10000&reason=LP%20is%20locked
 */
export const dynamic = "force-dynamic";

const VERDICTS: VerdictName[] = ["SAFE", "CAUTION", "AVOID", "UNKNOWN"];

export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const vRaw = (q.get("v") || "SAFE").toUpperCase();
  const verdict = (VERDICTS.includes(vRaw as VerdictName) ? vRaw : "SAFE") as VerdictName;

  return new ImageResponse(
    verdictArt({
      verdict,
      address: q.get("addr") || undefined,
      confidence: q.get("conf") || undefined,
      reason: q.get("reason") || undefined,
      size: q.get("size"),
    }),
    { width: 1200, height: 630 },
  );
}
