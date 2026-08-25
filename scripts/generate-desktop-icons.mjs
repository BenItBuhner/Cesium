import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ICO_SIZES, LINUX_PNG_SIZES, buildIco } from "./desktop-icons.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function svgToPng(svgBuffer, size) {
  return sharp(svgBuffer, { density: Math.max(size, 72) })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

export async function generateDesktopIcons({ root = repoRoot } = {}) {
  const svgBuffer = readFileSync(path.join(root, "public", "icon-source.svg"));
  const dest = path.join(root, "public", "desktop");
  mkdirSync(dest, { recursive: true });

  const pngBySize = new Map();
  for (const size of LINUX_PNG_SIZES) {
    const buf = await svgToPng(svgBuffer, size);
    pngBySize.set(size, buf);
    writeFileSync(path.join(dest, `${size}x${size}.png`), buf);
    console.log(`Created public/desktop/${size}x${size}.png`);
  }

  writeFileSync(path.join(dest, "icon.png"), pngBySize.get(1024));
  console.log("Created public/desktop/icon.png (1024)");

  const ico = buildIco(ICO_SIZES.map((size) => ({ size, buf: pngBySize.get(size) })));
  writeFileSync(path.join(dest, "icon.ico"), ico);
  console.log("Created public/desktop/icon.ico");
  return dest;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  generateDesktopIcons().catch((error) => {
    console.error("Desktop icon generation failed:", error);
    process.exit(1);
  });
}
