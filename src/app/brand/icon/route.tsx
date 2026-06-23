import { ImageResponse } from "next/og";
import { iconArt } from "@/lib/brand-art";

// High-res square app icon for Base App / store uploads. Download from /brand/icon.
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(iconArt(1024), { width: 1024, height: 1024 });
}
