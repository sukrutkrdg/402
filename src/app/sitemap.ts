import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/config";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl();
  const now = new Date();
  return [
    { url: site, lastModified: now, priority: 1 },
    { url: `${site}/agents`, lastModified: now, priority: 0.9 },
    { url: `${site}/stocks`, lastModified: now, priority: 0.9 },
    { url: `${site}/near`, lastModified: now, priority: 0.9 },
    { url: `${site}/swap`, lastModified: now, priority: 0.8 },
    // A fixed historical record rather than a live page, and the one thing here
    // worth citing: the first corporate action on a Coinbase tokenized equity,
    // with the block numbers to check it.
    { url: `${site}/stocks/first-corporate-action`, lastModified: now, priority: 0.9 },
    { url: `${site}/credits`, lastModified: now, priority: 0.8 },
    { url: `${site}/dashboard`, lastModified: now, priority: 0.5 },
  ];
}
