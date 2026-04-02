import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const SVG_SOURCE = path.join(process.cwd(), "public/icon-source.svg");
const ICON_DIR = path.join(process.cwd(), "public/icons");
const ROOT_DIR = process.cwd();

// Ensure icon dir exists
fs.mkdirSync(ICON_DIR, { recursive: true });

const svgBuffer = fs.readFileSync(SVG_SOURCE);

// Generate square PNG at given size
async function svgToPng(size) {
  return sharp(svgBuffer, { density: size })
    .resize(size, size)
    .png()
    .toBuffer();
}

// Build ICO file from multiple PNG sizes
function buildIco(pngBuffers) {
  // ICO header: 6 bytes
  // ICONDIR entry: 16 bytes each
  // Image data: PNG buffers
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = pngBuffers.map((buf, i) => ({
    size: sizes[i],
    buf,
  })).filter(x => x.buf);

  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = images.length;
  let dataOffset = headerSize + dirEntrySize * numImages;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // Reserved
  header.writeUInt16LE(1, 2);      // Type: 1 = ICO
  header.writeUInt16LE(numImages, 4); // Number of images

  const dirEntries = [];
  const imageData = [];

  for (const img of images) {
    const entry = Buffer.alloc(16);
    const size = img.size >= 256 ? 0 : img.size;
    entry.writeUInt8(size, 0);       // Width
    entry.writeUInt8(size, 1);        // Height
    entry.writeUInt8(0, 2);          // Color palette
    entry.writeUInt8(0, 3);          // Reserved
    entry.writeUInt16LE(1, 4);       // Color planes
    entry.writeUInt16LE(32, 6);      // Bits per pixel
    entry.writeUInt32LE(img.buf.length, 8);  // Image size
    entry.writeUInt32LE(dataOffset, 12);     // Image offset
    dataOffset += img.buf.length;
    dirEntries.push(entry);
    imageData.push(img.buf);
  }

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

async function main() {
  console.log("Generating icons from SVG...");

  // 192x192 icon
  const icon192 = await svgToPng(192);
  fs.writeFileSync(path.join(ICON_DIR, "icon-192.png"), icon192);
  console.log("Created icon-192.png");

  // 512x512 icon
  const icon512 = await svgToPng(512);
  fs.writeFileSync(path.join(ICON_DIR, "icon-512.png"), icon512);
  console.log("Created icon-512.png");

  // Maskable icon: pad the icon to 512x512 with transparent background,
  // centering the icon with ~20% padding on each side (safe zone for Android maskable)
  // The maskable spec says icon content should be in the inner 80%
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

  // Favicon ICO: include 16, 32, 48, 64, 128, 256 sizes
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(icoSizes.map((s) => svgToPng(s)));
  const ico = buildIco(pngBuffers);
  fs.writeFileSync(path.join(ROOT_DIR, "public/favicon.ico"), ico);
  console.log("Created favicon.ico");

  // Also save a favicon.png (256x256) for direct browser favicon.png use
  fs.writeFileSync(path.join(ROOT_DIR, "public/favicon.png"), pngBuffers[5]);
  console.log("Created favicon.png");

  console.log("All icons generated successfully.");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
