/**
 * Shared ICO encode/decode helpers for Cesium Desktop packaging.
 * ICO images are stored as PNG payloads (Windows Vista+), including a 256px
 * image so Explorer and NSIS do not fall back to Electron's default atom.
 */

export const ICO_SIZES = [16, 32, 48, 64, 128, 256];
export const LINUX_PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {{ size: number, buf: Buffer }[]} images
 */
export function buildIco(images) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const numImages = images.length;
  let dataOffset = headerSize + dirEntrySize * numImages;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  const dirEntries = [];
  const imageData = [];

  for (const img of images) {
    if (!img.buf || img.buf.length < 8) {
      throw new Error(`ICO image ${img.size} is missing PNG payload`);
    }
    const entry = Buffer.alloc(16);
    const size = img.size >= 256 ? 0 : img.size;
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.buf.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dataOffset += img.buf.length;
    dirEntries.push(entry);
    imageData.push(img.buf);
  }

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

/**
 * @param {Buffer} buffer
 */
export function parseIco(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
    throw new Error("ICO is empty or truncated");
  }
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    throw new Error(`Not an ICO file (reserved=${reserved} type=${type})`);
  }
  if (count < 1) {
    throw new Error("ICO contains no images");
  }

  const images = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    if (offset + 16 > buffer.length) {
      throw new Error("ICO directory is truncated");
    }
    const widthRaw = buffer.readUInt8(offset);
    const heightRaw = buffer.readUInt8(offset + 1);
    const bytes = buffer.readUInt32LE(offset + 8);
    const dataOffset = buffer.readUInt32LE(offset + 12);
    if (dataOffset + bytes > buffer.length) {
      throw new Error(`ICO image ${i} payload is truncated`);
    }
    const payload = buffer.subarray(dataOffset, dataOffset + bytes);
    images.push({
      width: widthRaw === 0 ? 256 : widthRaw,
      height: heightRaw === 0 ? 256 : heightRaw,
      payload,
      isPng: payload.length >= 8 && payload.subarray(0, 8).equals(PNG_MAGIC),
    });
  }
  return { count, images };
}

/**
 * @param {Buffer} buffer
 * @param {string} [label]
 */
export function assertValidDesktopIco(buffer, label = "icon.ico") {
  const parsed = parseIco(buffer);
  if (parsed.count < 4) {
    throw new Error(`${label} must contain at least 4 sizes (found ${parsed.count})`);
  }
  const sizes = new Set(parsed.images.map((image) => image.width));
  for (const required of [16, 32, 48, 256]) {
    if (!sizes.has(required)) {
      throw new Error(`${label} is missing a ${required}px image`);
    }
  }
  const pngCount = parsed.images.filter((image) => image.isPng).length;
  if (pngCount < 1) {
    throw new Error(`${label} has no PNG-compressed images; Windows Explorer needs a 256 PNG-in-ICO`);
  }
  return parsed;
}

/**
 * @param {Buffer} haystack
 * @param {Buffer} needle
 */
export function bufferContains(haystack, needle) {
  return haystack.indexOf(needle) !== -1;
}
