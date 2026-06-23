import { ImageResponse } from "next/og";
import { screenMarket } from "@/lib/brand-art";

// 1284×2778 App-Store promo screen (marketplace). Download from /brand/shot2.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(screenMarket(), { width: 1284, height: 2778 });
}
