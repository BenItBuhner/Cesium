import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

const staticExport = process.env.WEB_STATIC_EXPORT === "1";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV !== "production" || staticExport,
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: false,
  /** Avoid surprise full reloads when connectivity flaps (especially if PWA is enabled later). */
  reloadOnOnline: false,
  workboxOptions: {
    disableDevLogs: true,
  },
});

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Origins allowed to load dev-only /_next assets and HMR when not using localhost. */
const allowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean) ?? ["192.168.4.150"];

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot,
  output: staticExport ? "export" : undefined,
  trailingSlash: staticExport,
  images: {
    unoptimized: staticExport,
  },
  transpilePackages: ["@opencursor/client-sdk"],
  allowedDevOrigins,
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
