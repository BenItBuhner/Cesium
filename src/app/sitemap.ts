import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  return [
    { url: `${siteUrl}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/download`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/docs`, changeFrequency: "weekly", priority: 0.6 },
  ];
}
