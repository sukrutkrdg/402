import { ImageResponse } from "next/og";
import { screenHero } from "@/lib/brand-art";

// 1284×2778 App-Store promo screen (hero). Download from /brand/shot1.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(screenHero(), { width: 1284, height: 2778 });
}
