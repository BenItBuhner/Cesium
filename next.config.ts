import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

/**
 * Disable the PWA/service worker by default. It has repeatedly served stale HTML
 * across local rebuilds, which leaves the browser loading chunk hashes that no
 * longer exist and the app gets stuck on the SSR auth splash forever.
 *
 * To opt back in intentionally, build/run with:
 *   ENABLE_NEXT_PWA=1
 */
const pwaEnabled = process.env.ENABLE_NEXT_PWA === "1";
const pwaDisabled = process.env.NODE_ENV !== "production" || !pwaEnabled;

const withPWA = withPWAInit({
  dest: "public",
  disable: pwaDisabled,
  /** Stale navigations + CacheFirst on /_next/static caused ChunkLoadError after rebuilds (HTML ref old hashes). */
  cacheOnFrontEndNav: false,
  aggressiveFrontEndNavCaching: false,
  /** Avoid surprise full reloads when connectivity flaps (especially if PWA is enabled later). */
  reloadOnOnline: false,
  /**
   * Override default `/_next/static/*.js` rule: same cacheName replaces CacheFirst with NetworkFirst
   * (see next-pwa `extendDefaultRuntimeCaching` / cacheName override behavior).
   */
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      {
        urlPattern: /\/_next\/static.+\.js$/i,
        handler: "NetworkFirst",
        method: "GET",
        options: {
          cacheName: "next-static-js-assets",
          networkTimeoutSeconds: 4,
          expiration: {
            maxEntries: 96,
            maxAgeSeconds: 24 * 60 * 60,
          },
        },
      },
    ],
  },
});

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

/** Origins allowed to load dev-only /_next assets and HMR when not using localhost. */
const allowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [
      "localhost",
      "localhost:3000",
      "127.0.0.1",
      "127.0.0.1:3000",
      "192.168.4.150",
    ];

/**
 * Production security headers, applied to every route on public deployments.
 * Kept conservative on purpose: the workbench uses microphone capture (voice
 * input), WebSockets, and cross-origin engine APIs, so no CSP/permission that
 * would break those is set here.
 */
const productionSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
];

const nextConfig: NextConfig = {
  // The React Compiler is currently crashing Next.js during page compilation
  // in this deployment. Keep it off so production and dev builds can complete.
  reactCompiler: false,
  turbopack: {},
  experimental: {
    /**
     * Persist Turbopack's compile graph under .next/cache so builds that
     * restore the previous cache (Vercel, CI with .next/cache cached) start
     * warm instead of recompiling everything. Default-on since Next 16.3;
     * kept explicit so a future default flip cannot silently regress builds.
     */
    turbopackFileSystemCacheForBuild: true,
  },
  /**
   * Type checking is NOT skipped: `npm run build` runs `npm run typecheck`
   * (next typegen + TypeScript 7 native compiler) before `next build`, and a
   * type error still fails the build. Next's own pass would re-run the same
   * check with the TypeScript 5 API (~25s on Vercel), so it is turned off.
   * TS 5 stays installed as `typescript` only because typescript-eslint does
   * not support TS 7 yet.
   */
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: workspaceRoot,
  allowedDevOrigins,
  poweredByHeader: false,
  /** Hide the floating Next dev indicator so it stops covering the bottom-left rail. */
  devIndicators: false,
  env: {
    NEXT_PUBLIC_ENABLE_NEXT_PWA: pwaEnabled ? "1" : "0",
  },
  /** Dev: stop the browser from keeping old `/_next/static` after HMR / restart (ChunkLoadError on wrong content-hash). */
  async headers() {
    if (process.env.NODE_ENV !== "production") {
      return [
        {
          source: "/_next/static/:path*",
          headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
        },
      ];
    }
    return [
      {
        source: "/(.*)",
        headers: productionSecurityHeaders,
      },
    ];
  },
};

export default withPWA(nextConfig);
