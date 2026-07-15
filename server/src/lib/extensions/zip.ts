import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

export type ZipLimits = {
  maxEntries: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minSize = 22;
  const maxCommentLength = 0xffff;
  const start = Math.max(0, buffer.length - minSize - maxCommentLength);
  for (let offset = buffer.length - minSize; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("Invalid VSIX: missing ZIP end-of-central-directory.");
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertSafeEntryName(name: string): void {
  const normalized = normalizeEntryName(name);
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Invalid VSIX: empty or null-byte entry name.");
  }
  if (path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid VSIX: unsafe entry path ${name}`);
  }
}

export function readZipEntries(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  if (buffer.length > limits.maxCompressedBytes) {
    throw new Error(`VSIX exceeds compressed size limit (${limits.maxCompressedBytes} bytes).`);
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > limits.maxEntries) {
    throw new Error(`VSIX contains too many files (${totalEntries}).`);
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    throw new Error("Invalid VSIX: central directory points outside file.");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  let uncompressedTotal = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Invalid VSIX: malformed central directory.");
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = normalizeEntryName(
      buffer.toString("utf8", cursor + 46, cursor + 46 + fileNameLength)
    );
    assertSafeEntryName(name);
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > limits.maxUncompressedBytes) {
      throw new Error(
        `VSIX exceeds extracted size limit (${limits.maxUncompressedBytes} bytes).`
      );
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const cursor = entry.localHeaderOffset;
  if (buffer.readUInt32LE(cursor) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid VSIX: malformed local header for ${entry.name}.`);
  }
  const fileNameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  const dataOffset = cursor + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Invalid VSIX: entry data points outside file for ${entry.name}.`);
  }
  const compressed = buffer.subarray(dataOffset, dataEnd);
  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error(
    `Unsupported VSIX compression method ${entry.compressionMethod} for ${entry.name}.`
  );
}

export async function extractZip(buffer: Buffer, destination: string, limits: ZipLimits) {
  const entries = readZipEntries(buffer, limits);
  await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      continue;
    }
    const outPath = path.resolve(destination, entry.name);
    const relative = path.relative(destination, outPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Invalid VSIX: unsafe extraction path ${entry.name}.`);
    }
    const data = readZipEntry(buffer, entry);
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`Invalid VSIX: size mismatch for ${entry.name}.`);
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, data);
  }
  return entries;
}

export function readTextEntry(buffer: Buffer, entries: ZipEntry[], name: string): string | null {
  const normalized = normalizeEntryName(name);
  const entry = entries.find((candidate) => normalizeEntryName(candidate.name) === normalized);
  if (!entry) {
    return null;
  }
  return readZipEntry(buffer, entry).toString("utf8");
}
