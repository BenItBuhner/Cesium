import { NextResponse } from "next/server";
import {
  CESIUM_GITHUB_REPO,
  CESIUM_RELEASES_URL,
  parseGitHubRelease,
} from "@/lib/releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Latest-release catalog for the /download page.
 *
 * Always hit GitHub for the current `releases/latest` payload. The previous
 * `next: { revalidate: 600 }` + `stale-while-revalidate=3600` combo kept
 * serving the prior tag (v0.9.0) after v0.10.0 published - Vercel CDN MISS
 * still returned the Next data-cache SWR entry. A new GitHub release must
 * show up on /download immediately. Set GITHUB_TOKEN (or
 * GITHUB_RELEASES_TOKEN) in the deployment for a higher upstream rate limit;
 * a public repo works fine without one.
 */
export async function GET() {
  const token =
    process.env.GITHUB_RELEASES_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim();
  try {
    const response = await fetch(
      `https://api.github.com/repos/${CESIUM_GITHUB_REPO}/releases/latest`,
      {
        cache: "no-store",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub responded ${response.status}`);
    }
    const catalog = parseGitHubRelease(await response.json());
    if (!catalog) {
      throw new Error("Unrecognized GitHub release payload");
    }
    return NextResponse.json(catalog, {
      headers: {
        "cache-control": "private, no-store, must-revalidate",
      },
    });
  } catch (error) {
    // Never break the download page: the client falls back to linking the
    // GitHub releases index when no structured catalog is available.
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "release fetch failed",
        htmlUrl: CESIUM_RELEASES_URL,
      },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}
