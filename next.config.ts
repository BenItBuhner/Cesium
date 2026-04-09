import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

/** Set DISABLE_NEXT_PWA=1 when running `next start` locally to skip the service worker (avoids stale chunk / ChunkLoadError after rebuilds). */
const pwaDisabled =
  process.env.NODE_ENV !== "production" || process.env.DISABLE_NEXT_PWA === "1";

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
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot,
  allowedDevOrigins,
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
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/.opencursor-data/**",
          "**/server/.opencursor-data/**",
        ],
      };
    }
    return config;
  },
};

export default withPWA(nextConfig);
