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
    { url: `${site}/status`, lastModified: now, priority: 0.6 },
    // A fixed historical record rather than a live page, and the one thing here
    // worth citing: the first corporate action on a Coinbase tokenized equity,
    // with the block numbers to check it.
    { url: `${site}/stocks/first-corporate-action`, lastModified: now, priority: 0.9 },
    { url: `${site}/credits`, lastModified: now, priority: 0.8 },
    { url: `${site}/dashboard`, lastModified: now, priority: 0.5 },
    { url: `${site}/app`, lastModified: now, priority: 0.8 },
    { url: `${site}/scout`, lastModified: now, priority: 0.6 },
    { url: `${site}/playground`, lastModified: now, priority: 0.6 },
    { url: `${site}/workflows`, lastModified: now, priority: 0.7 },
    { url: `${site}/terminal`, lastModified: now, priority: 0.5 },
    { url: `${site}/fleet`, lastModified: now, priority: 0.7 },
    { url: `${site}/radar`, lastModified: now, priority: 0.6 },
    { url: `${site}/leaderboard`, lastModified: now, priority: 0.6 },
  ];
}
