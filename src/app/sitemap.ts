import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  return [
    { url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/download`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/terms`, changeFrequency: "monthly", priority: 0.4 },
    { url: `${siteUrl}/license`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
