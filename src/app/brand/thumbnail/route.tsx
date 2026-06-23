import { ImageResponse } from "next/og";
import { thumbArt } from "@/lib/brand-art";

// 1200×630 thumbnail / hero image for Base App uploads. Download from /brand/thumbnail.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(thumbArt(), { width: 1200, height: 630 });
}
