import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/download"],
        // The workbench itself and its APIs are application surface, not
        // content — keep crawlers on the marketing pages.
        disallow: ["/agent", "/editor", "/workspace", "/setup", "/api/"],
      },
    ],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
