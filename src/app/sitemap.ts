import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/config";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl();
  const now = new Date();
  return [
    { url: site, lastModified: now, priority: 1 },
    { url: `${site}/agents`, lastModified: now, priority: 0.9 },
    { url: `${site}/dashboard`, lastModified: now, priority: 0.5 },
  ];
}
