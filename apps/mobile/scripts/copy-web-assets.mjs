import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss from "postcss";

const repoRoot = resolve(import.meta.dirname, "../../..");
const source = resolve(repoRoot, "apps/desktop-renderer/dist");
const target = resolve(import.meta.dirname, "../android/app/src/main/assets/workbench");
const flattenCascadeLayers = {
  postcssPlugin: "cesium-flatten-cascade-layers",
  AtRule: {
    layer(atRule) {
      if (atRule.nodes?.length) {
        atRule.replaceWith(...atRule.nodes);
      } else {
        atRule.remove();
      }
    },
  },
};

async function ensureBuiltSource() {
  try {
    if ((await stat(source)).isDirectory()) return;
  } catch {
    // Fall through to the actionable error.
  }
  throw new Error(
    `Missing Vite workbench bundle at ${source}. Run ` +
      `"npm run build --workspace @cesium/desktop-renderer" first.`
  );
}

await ensureBuiltSource();
await rm(target, { force: true, recursive: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

// Vite adds `crossorigin` to module/style assets for HTTP deployments.
// Chromium 83 treats a file:// stylesheet with that attribute as a CORS fetch
// and silently drops it. All referenced assets are inside the signed APK, so
// remove the attribute from the mobile copy.
const indexPath = resolve(target, "index.html");
const indexHtml = await readFile(indexPath, "utf8");
await writeFile(indexPath, indexHtml.replace(/\s+crossorigin(?=[\s>])/g, ""), "utf8");

// Android 11's Chromium 83 predates CSS cascade layers. Tailwind 4 wraps its
// utility output in @layer blocks, which old WebViews discard wholesale and
// leaves an otherwise functional app completely unstyled. Flatten the layers
// only in the Android asset copy; Electron and modern web keep the native CSS.
const assetsDir = resolve(target, "assets");
let bundledCss = "";
for (const filename of await readdir(assetsDir)) {
  if (!filename.endsWith(".css")) continue;
  const cssPath = resolve(assetsDir, filename);
  const sourceCss = await readFile(cssPath, "utf8");
  const result = await postcss([flattenCascadeLayers]).process(sourceCss, {
    from: cssPath,
    to: cssPath,
  });
  await writeFile(cssPath, result.css, "utf8");
  bundledCss += `${result.css}\n`;
}

// Older WebViews also apply stricter file-origin rules to linked stylesheets.
// Inline the already-minified CSS into the local index so the first paint is
// deterministic and does not depend on file:// stylesheet fetch behavior.
if (bundledCss) {
  const mobileIndex = await readFile(indexPath, "utf8");
  const inlined = mobileIndex.replace(
    /<link\s+rel=["']stylesheet["'][^>]*>/g,
    `<style data-cesium-bundled>${bundledCss.replace(/<\/style/gi, "<\\/style")}</style>`
  );
  await writeFile(indexPath, inlined, "utf8");
}

console.log(`Copied Cesium web workbench to ${target}`);
