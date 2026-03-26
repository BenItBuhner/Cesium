import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: false,
  reloadOnOnline: true,
  workboxOptions: {
    disableDevLogs: true,
  },
});

const workspaceRoot = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  reactCompiler: true,
  outputFileTracingRoot: workspaceRoot,
};

export default withPWA(nextConfig);
