import type { MetadataRoute } from "next";

// Allow all crawlers (incl. AI/agent crawlers) full access.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
  };
}
