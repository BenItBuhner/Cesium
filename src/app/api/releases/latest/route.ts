import { NextResponse } from "next/server";
import {
  CESIUM_GITHUB_REPO,
  CESIUM_RELEASES_URL,
  parseGitHubRelease,
} from "@/lib/releases";

export const runtime = "nodejs";

/**
 * Latest-release catalog for the /download page.
 *
 * Proxying GitHub through our own origin keeps the client free of GitHub API
 * rate limits (60/hr per IP unauthenticated) — the fetch below is cached by
 * Next for 10 minutes and shared across all visitors. Set GITHUB_TOKEN (or
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
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        next: { revalidate: 600 },
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
        "cache-control": "public, s-maxage=600, stale-while-revalidate=3600",
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
