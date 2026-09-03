import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/**
 * Streaming ZIP extractor for large binary archives (hundreds of MB to a few
 * GB). The VSIX reader in `extensions/zip.ts` inflates whole entries in
 * memory, which is fine for extensions but not for Google's ~700 MB Antigravity
 * ACP server whose main entry is ~1.9 GB. This reader parses the central
 * directory through positional fd reads and streams each entry
 * `createReadStream -> createInflateRaw -> createWriteStream`, so peak memory
 * stays at stream buffer size regardless of archive size. Zip64 records are
 * honored because archive tooling may emit them even below the 4 GiB limits.
 */

export type StreamZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  /** POSIX mode bits when the archive was made on Unix, else null. */
  unixMode: number | null;
  isDirectory: boolean;
};

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_UINT32 = 0xffffffff;

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error("Unexpected end of archive while reading.");
    }
    offset += bytesRead;
  }
  return buffer;
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertSafeEntryName(name: string): void {
  if (!name || name.includes("\0")) {
    throw new Error("Invalid archive: empty or null-byte entry name.");
  }
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid archive: unsafe entry path ${name}`);
  }
}

function readUInt64LE(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid archive: 64-bit field exceeds the safe integer range.");
  }
  return Number(value);
}

type CentralDirectoryLocation = {
  totalEntries: number;
  size: number;
  offset: number;
};

async function locateCentralDirectory(
  handle: fs.FileHandle,
  fileSize: number
): Promise<CentralDirectoryLocation> {
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  const tail = await readAt(handle, fileSize - tailLength, tailLength);
  let eocdIndex = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdIndex = offset;
      break;
    }
  }
  if (eocdIndex < 0) {
    throw new Error("Invalid archive: missing ZIP end-of-central-directory.");
  }
  const eocdPosition = fileSize - tailLength + eocdIndex;
  let totalEntries: number = tail.readUInt16LE(eocdIndex + 10);
  let size: number = tail.readUInt32LE(eocdIndex + 12);
  let offset: number = tail.readUInt32LE(eocdIndex + 16);

  const needsZip64 =
    totalEntries === 0xffff || size === MAX_UINT32 || offset === MAX_UINT32;
  if (needsZip64 || eocdPosition >= 20) {
    // Zip64 EOCD locator sits immediately before the EOCD record.
    const locatorPosition = eocdPosition - 20;
    if (locatorPosition >= 0) {
      const locator = await readAt(handle, locatorPosition, 20);
      if (locator.readUInt32LE(0) === EOCD64_LOCATOR_SIGNATURE) {
        const eocd64Position = readUInt64LE(locator, 8);
        const eocd64 = await readAt(handle, eocd64Position, 56);
        if (eocd64.readUInt32LE(0) !== EOCD64_SIGNATURE) {
          throw new Error("Invalid archive: malformed Zip64 end-of-central-directory.");
        }
        totalEntries = readUInt64LE(eocd64, 32);
        size = readUInt64LE(eocd64, 40);
        offset = readUInt64LE(eocd64, 48);
      } else if (needsZip64) {
        throw new Error("Invalid archive: Zip64 sizes without a Zip64 locator.");
      }
    }
  }
  if (offset + size > fileSize) {
    throw new Error("Invalid archive: central directory points outside file.");
  }
  return { totalEntries, size, offset };
}

function applyZip64Extra(
  extra: Buffer,
  fields: { uncompressedSize: number; compressedSize: number; localHeaderOffset: number }
): void {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    const body = extra.subarray(cursor + 4, cursor + 4 + length);
    if (id === ZIP64_EXTRA_ID) {
      let position = 0;
      if (fields.uncompressedSize === MAX_UINT32 && position + 8 <= body.length) {
        fields.uncompressedSize = readUInt64LE(body, position);
        position += 8;
      }
      if (fields.compressedSize === MAX_UINT32 && position + 8 <= body.length) {
        fields.compressedSize = readUInt64LE(body, position);
        position += 8;
      }
      if (fields.localHeaderOffset === MAX_UINT32 && position + 8 <= body.length) {
        fields.localHeaderOffset = readUInt64LE(body, position);
      }
      return;
    }
    cursor += 4 + length;
  }
}

export type StreamZipLimits = {
  maxEntries: number;
  maxUncompressedBytes: number;
};

export async function readStreamZipEntries(
  archivePath: string,
  limits: StreamZipLimits
): Promise<StreamZipEntry[]> {
  const handle = await fs.open(archivePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const location = await locateCentralDirectory(handle, fileSize);
    if (location.totalEntries > limits.maxEntries) {
      throw new Error(`Archive contains too many files (${location.totalEntries}).`);
    }
    const directory = await readAt(handle, location.offset, location.size);
    const entries: StreamZipEntry[] = [];
    let cursor = 0;
    let uncompressedTotal = 0;
    for (let index = 0; index < location.totalEntries; index += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error("Invalid archive: malformed central directory.");
      }
      const versionMadeBy = directory.readUInt16LE(cursor + 4);
      const compressionMethod = directory.readUInt16LE(cursor + 10);
      const fields = {
        compressedSize: directory.readUInt32LE(cursor + 20),
        uncompressedSize: directory.readUInt32LE(cursor + 24),
        localHeaderOffset: directory.readUInt32LE(cursor + 42),
      };
      const fileNameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      const nameStart = cursor + 46;
      const name = normalizeEntryName(
        directory.toString("utf8", nameStart, nameStart + fileNameLength)
      );
      assertSafeEntryName(name);
      const extra = directory.subarray(
        nameStart + fileNameLength,
        nameStart + fileNameLength + extraLength
      );
      applyZip64Extra(extra, fields);
      uncompressedTotal += fields.uncompressedSize;
      if (uncompressedTotal > limits.maxUncompressedBytes) {
        throw new Error(
          `Archive exceeds extracted size limit (${limits.maxUncompressedBytes} bytes).`
        );
      }
      // "Version made by" high byte 3 = Unix; mode lives in the high 16 bits.
      const madeOnUnix = (versionMadeBy >> 8) === 3;
      const unixMode = madeOnUnix ? (externalAttributes >>> 16) & 0o7777 : null;
      entries.push({
        name,
        compressedSize: fields.compressedSize,
        uncompressedSize: fields.uncompressedSize,
        compressionMethod,
        localHeaderOffset: fields.localHeaderOffset,
        unixMode,
        isDirectory: name.endsWith("/"),
      });
      cursor += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function entryDataOffset(handle: fs.FileHandle, entry: StreamZipEntry): Promise<number> {
  const header = await readAt(handle, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid archive: malformed local header for ${entry.name}.`);
  }
  const fileNameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraLength;
}

export type StreamZipExtractOptions = {
  limits: StreamZipLimits;
  signal?: AbortSignal;
  /** Called after each entry finishes with cumulative uncompressed bytes. */
  onProgress?: (input: { entry: StreamZipEntry; writtenBytes: number; totalBytes: number }) => void;
};

/**
 * Extracts `archivePath` into `destination` (created if missing). Entry paths
 * are confined to `destination`; symlink entries are written as regular files
 * (the archive format stores their target as content), which is acceptable for
 * vendor binary bundles and avoids link-based escapes.
 */
export async function extractStreamZip(
  archivePath: string,
  destination: string,
  options: StreamZipExtractOptions
): Promise<StreamZipEntry[]> {
  const entries = await readStreamZipEntries(archivePath, options.limits);
  await fs.mkdir(destination, { recursive: true });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const handle = await fs.open(archivePath, "r");
  let writtenBytes = 0;
  try {
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const outPath = path.resolve(destination, entry.name);
      const relative = path.relative(destination, outPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Invalid archive: unsafe extraction path ${entry.name}.`);
      }
      if (entry.isDirectory) {
        await fs.mkdir(outPath, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      const dataOffset = await entryDataOffset(handle, entry);
      const source = createReadStream(archivePath, {
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1,
        highWaterMark: 1024 * 1024,
      });
      const sink = createWriteStream(outPath, {
        mode: entry.unixMode ?? 0o644,
      });
      if (entry.compressionMethod === 0) {
        await pipeline(source, sink, { signal: options.signal });
      } else if (entry.compressionMethod === 8) {
        await pipeline(source, createInflateRaw(), sink, { signal: options.signal });
      } else {
        source.destroy();
        sink.destroy();
        throw new Error(
          `Unsupported compression method ${entry.compressionMethod} for ${entry.name}.`
        );
      }
      const written = await fs.stat(outPath);
      if (written.size !== entry.uncompressedSize) {
        throw new Error(`Invalid archive: size mismatch for ${entry.name}.`);
      }
      if (entry.unixMode !== null && process.platform !== "win32") {
        await fs.chmod(outPath, entry.unixMode).catch(() => undefined);
      }
      writtenBytes += entry.uncompressedSize;
      options.onProgress?.({ entry, writtenBytes, totalBytes });
    }
  } finally {
    await handle.close();
  }
  return entries;
}
