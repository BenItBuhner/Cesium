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
    // onnxruntime-web exposes an "extern wasm" build under this condition. The
    // voice VAD loads the wasm from `/voice/ort/` at runtime (wasmPaths), so the
    // default bundle's `new URL(*.wasm, import.meta.url)` only made Vite emit a
    // dead 26 MB wasm into the desktop package and the Android APK assets.
    conditions: ["onnxruntime-web-use-extern-wasm"],
    alias: {
      "@": r("../../src"),
      "@convex": r("../../convex"),
      "next/dynamic": r("./src/next-shims/dynamic.tsx"),
      "next/link": r("./src/next-shims/link.tsx"),
      "next/navigation": r("./src/next-shims/navigation.tsx"),
      // @clerk/nextjs ships Next server actions that cannot bundle in the
      // standalone renderer; the adapter re-exports the equivalent React
      // surface from @clerk/react so cloud sign-in works in packaged apps.
      // The real `convex` package (a renderer dependency) needs no shims.
      "@clerk/nextjs": r("./src/next-shims/clerk.tsx"),
      "@cesium/browser-machine": r("../../packages/browser-machine/src/index.ts"),
      "@cesium/core": r("../../packages/core/src/index.ts"),
      "@cesium/contracts/cloud-agents": r("../../packages/contracts/src/cloud-agents.ts"),
      "@cesium/contracts/meta": r("../../packages/contracts/src/meta.ts"),
      "@cesium/contracts": r("../../packages/contracts/src/index.ts"),
      "@cesium/sdk": r("../../packages/sdk/src/index.ts"),
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
    // Cloud accounts (Convex + Clerk) default to production behavior on every
    // platform: build-time env overrides win, otherwise the committed
    // defaults in src/lib/cloud/cloud-defaults.ts apply. Users can flip any
    // client to local-only at runtime (Settings → Account → Cloud sync).
    "process.env.NEXT_PUBLIC_CESIUM_CLOUD": JSON.stringify(
      process.env.NEXT_PUBLIC_CESIUM_CLOUD ?? undefined
    ),
    "process.env.NEXT_PUBLIC_CONVEX_URL": JSON.stringify(
      process.env.NEXT_PUBLIC_CONVEX_URL ?? undefined
    ),
    "process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": JSON.stringify(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? undefined
    ),
    // Sign-in gating is a hosted-web posture (enforced by the Next proxy);
    // the packaged apps keep sign-in optional.
    "process.env.NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN": JSON.stringify(undefined),
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
