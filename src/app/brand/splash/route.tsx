import { ImageResponse } from "next/og";
import { iconArt } from "@/lib/brand-art";

// 200×200 splash image for the Farcaster Mini App launch screen. /brand/splash
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(iconArt(200), { width: 200, height: 200 });
}
