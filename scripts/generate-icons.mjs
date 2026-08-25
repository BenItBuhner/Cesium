import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { ICO_SIZES, buildIco } from "./desktop-icons.mjs";
import { generateDesktopIcons } from "./generate-desktop-icons.mjs";

const SVG_SOURCE = path.join(process.cwd(), "public/icon-source.svg");
const ICON_DIR = path.join(process.cwd(), "public/icons");
const ROOT_DIR = process.cwd();

fs.mkdirSync(ICON_DIR, { recursive: true });

const svgBuffer = fs.readFileSync(SVG_SOURCE);

async function svgToPng(size) {
  return sharp(svgBuffer, { density: size })
    .resize(size, size)
    .png()
    .toBuffer();
}

async function main() {
  console.log("Generating icons from SVG...");

  const icon192 = await svgToPng(192);
  fs.writeFileSync(path.join(ICON_DIR, "icon-192.png"), icon192);
  console.log("Created icon-192.png");

  const icon512 = await svgToPng(512);
  fs.writeFileSync(path.join(ICON_DIR, "icon-512.png"), icon512);
  console.log("Created icon-512.png");

  const maskable512 = sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await svgToPng(384),
        gravity: "center",
      },
    ])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(ICON_DIR, "maskable-512.png"), await maskable512);
  console.log("Created maskable-512.png");

  const pngBuffers = await Promise.all(ICO_SIZES.map((s) => svgToPng(s)));
  const ico = buildIco(ICO_SIZES.map((size, i) => ({ size, buf: pngBuffers[i] })));
  fs.writeFileSync(path.join(ROOT_DIR, "public/favicon.ico"), ico);
  console.log("Created favicon.ico");

  fs.writeFileSync(path.join(ROOT_DIR, "public/favicon.png"), pngBuffers[ICO_SIZES.indexOf(256)]);
  console.log("Created favicon.png");

  await generateDesktopIcons({ root: ROOT_DIR });

  console.log("All icons generated successfully.");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
