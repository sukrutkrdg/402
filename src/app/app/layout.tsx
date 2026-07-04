import type { Metadata } from "next";
import { Providers } from "./providers";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://402.com.tr").replace(/\/$/, "");

// Mini App embed for the /app page specifically, so casting the /app link
// launches the token-safety checker (not the home page).
const action = {
  url: `${SITE}/app`,
  name: "x402 Bazaar",
  splashImageUrl: `${SITE}/brand/splash`,
  splashBackgroundColor: "#07080a",
};
const miniapp = JSON.stringify({
  version: "1",
  imageUrl: `${SITE}/brand/embed`,
  button: { title: "Check token safety", action: { type: "launch_miniapp", ...action } },
});
const frame = JSON.stringify({
  version: "1",
  imageUrl: `${SITE}/brand/embed`,
  button: { title: "Check token safety", action: { type: "launch_frame", ...action } },
});

export const metadata: Metadata = {
  other: { "fc:miniapp": miniapp, "fc:frame": frame },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
