#!/usr/bin/env node
/**
 * Vercel build entrypoint: push `convex/` to the Convex deployment, then build
 * the Next.js app.
 *
 * Vercel only ships the web bundle. Convex schema + functions live in a
 * separate cloud deployment that is updated by `npx convex deploy`; without
 * this step a merged change to `convex/*.ts` never reaches production and the
 * client talks to stale backend functions.
 *
 * Behavior is keyed off `CONVEX_DEPLOY_KEY`, which Vercel injects per
 * environment:
 *
 * - Production (a "Production" deploy key): `convex deploy` pushes `convex/`
 *   to the production deployment, then runs the Next build. The Convex URL
 *   is exposed to the build as NEXT_PUBLIC_CONVEX_URL.
 * - Preview (a "Preview" deploy key, optional): Convex creates an isolated
 *   preview deployment per branch, pushes `convex/`, and the Next build gets
 *   that preview URL.
 * - No key: plain `next build`. The client falls back to
 *   `src/lib/cloud/cloud-defaults.ts` (production Convex + Clerk), which is
 *   what unconfigured previews did before this script existed.
 */
import { spawnSync } from "node:child_process";

const deployKey = process.env.CONVEX_DEPLOY_KEY?.trim();
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  console.log(`[vercel-build] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!deployKey) {
  console.log(
    "[vercel-build] CONVEX_DEPLOY_KEY is not set - skipping `convex deploy`, running `next build` only."
  );
  run(npm, ["run", "build"]);
} else {
  const kind = deployKey.startsWith("preview:")
    ? "preview"
    : deployKey.startsWith("prod:")
      ? "production"
      : "unknown-kind";
  console.log(`[vercel-build] CONVEX_DEPLOY_KEY present (${kind}) - deploying convex/ first.`);
  run(npx, [
    "convex",
    "deploy",
    "--cmd",
    "npm run build",
    "--cmd-url-env-var-name",
    "NEXT_PUBLIC_CONVEX_URL",
  ]);
}
