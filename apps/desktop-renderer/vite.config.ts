import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "./",
  appType: "spa",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": r("../../src"),
      "next/dynamic": r("./src/next-shims/dynamic.tsx"),
      "next/link": r("./src/next-shims/link.tsx"),
      "next/navigation": r("./src/next-shims/navigation.tsx"),
      "@cesium/core": r("../../packages/core/src/index.ts"),
      "@cesium/client/react": r("../../packages/client/src/react.ts"),
      "@cesium/client": r("../../packages/client/src/index.ts"),
      "@cesium/design": r("../../packages/design/src/index.ts"),
      "@cesium/ui-web": r("../../packages/ui-web/src/index.ts"),
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
    "process.env.NEXT_PUBLIC_ENABLE_NEXT_PWA": JSON.stringify("0"),
    "process.env.NEXT_PUBLIC_SERVER_URL": JSON.stringify(undefined),
  },
  build: {
    // Android 11's bundled System WebView is Chromium 83, but its WebView V8
    // build lacks several syntax features that desktop Chrome 83 exposes
    // (notably public class fields). ES2018 forces those constructs through
    // esbuild while Electron and modern browsers run the same output unchanged.
    target: "es2018",
    outDir: "dist",
    emptyOutDir: true,
  },
});
