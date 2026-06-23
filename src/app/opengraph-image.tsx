import { ImageResponse } from "next/og";
import { thumbArt } from "@/lib/brand-art";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "x402 Bazaar — pay-per-call API marketplace on Base";

export default function OpengraphImage() {
  return new ImageResponse(thumbArt(), { ...size });
}
