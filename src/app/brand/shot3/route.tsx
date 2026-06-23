import { ImageResponse } from "next/og";
import { screenAttribution } from "@/lib/brand-art";

// 1284×2778 App-Store promo screen (attribution). Download from /brand/shot3.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(screenAttribution(), { width: 1284, height: 2778 });
}
