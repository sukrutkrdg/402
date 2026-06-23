import { ImageResponse } from "next/og";
import { thumbArt } from "@/lib/brand-art";

// 1200×800 (3:2) embed image for Farcaster Mini App share cards. /brand/embed
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(thumbArt(), { width: 1200, height: 800 });
}
