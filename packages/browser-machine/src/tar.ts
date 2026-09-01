/**
 * Minimal ustar tarball extraction (optionally gzip-compressed via the
 * native DecompressionStream). Shared by the GitHub tarball importer and
 * the npm registry client.
 */

export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes.slice().buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export async function extractTarball(
  bytes: Uint8Array,
  writeEntry: (path: string, data: Uint8Array, isDir: boolean) => void
): Promise<void> {
  const data = await gunzipIfNeeded(bytes);
  const decoder = new TextDecoder();
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!rawName) break;
    const sizeOctal = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeOctal || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 48);
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const fullName = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    offset += 512;
    const body = data.subarray(offset, offset + size);
    if (typeFlag === "L") {
      // GNU long name entry: applies to the next header.
      longName = decoder.decode(body).replace(/\0.*$/, "");
    } else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
      writeEntry(fullName, body, false);
    } else if (typeFlag === "5") {
      writeEntry(fullName, new Uint8Array(0), true);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}
