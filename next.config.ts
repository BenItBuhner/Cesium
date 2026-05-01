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
    .filter(Boolean) ?? ["192.168.4.150"];

const nextConfig: NextConfig = {
  // The React Compiler is currently crashing Next.js during page compilation
  // in this deployment. Keep it off so production and dev builds can complete.
  reactCompiler: false,
  turbopack: {},
  outputFileTracingRoot: workspaceRoot,
  allowedDevOrigins,
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
    return [];
  },
};

export default withPWA(nextConfig);
