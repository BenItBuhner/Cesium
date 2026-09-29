import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../persistence.js";
import type { AgentStoredEvent } from "../types.js";
import { truncationMarker } from "./cesium-coerce.js";
import { CESIUM_TOOL_RESULT_MODEL_MAX_CHARS } from "./cesium-prompt.js";

/** Tool results longer than this are stored once as a blob; the event keeps a preview. */
export const CESIUM_TOOL_RESULT_BLOB_MIN_CHARS = 64 * 1024;
const PREVIEW_HEAD_CHARS = Math.ceil(CESIUM_TOOL_RESULT_MODEL_MAX_CHARS / 2);
const PREVIEW_TAIL_CHARS = CESIUM_TOOL_RESULT_MODEL_MAX_CHARS - PREVIEW_HEAD_CHARS;
const BLOB_CACHE_MAX_CHARS = 32 * 1024 * 1024;

export type CesiumToolResultBlobRef = { sha256: string; chars: number };

const blobCache = new Map<string, string>();
let blobCacheChars = 0;

function blobRoot(): string {
  return path.join(DATA_DIR, "tool-output", "blobs");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function toolResultBlobPath(sha256: string): string {
  return path.join(blobRoot(), sha256.slice(0, 2), `${sha256}.txt`);
}

function rememberBlob(sha256: string, content: string): void {
  if (content.length > BLOB_CACHE_MAX_CHARS) {
    return;
  }
  const previous = blobCache.get(sha256);
  if (previous !== undefined) {
    blobCache.delete(sha256);
    blobCacheChars -= previous.length;
  }
  blobCache.set(sha256, content);
  blobCacheChars += content.length;
  for (const [key, value] of blobCache) {
    if (blobCacheChars <= BLOB_CACHE_MAX_CHARS) {
      break;
    }
    blobCache.delete(key);
    blobCacheChars -= value.length;
  }
}

/** Writes `content` under its sha256 (once; identical results share a file). */
export async function writeToolResultBlob(content: string): Promise<CesiumToolResultBlobRef> {
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const target = toolResultBlobPath(sha256);
  const exists = await fs.stat(target).then(
    () => true,
    () => false
  );
  if (!exists) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, content, "utf8");
    await fs.rename(temp, target);
  }
  rememberBlob(sha256, content);
  return { sha256, chars: content.length };
}

export async function readToolResultBlob(ref: CesiumToolResultBlobRef): Promise<string | null> {
  if (!isSha256(ref.sha256)) {
    return null;
  }
  const cached = blobCache.get(ref.sha256);
  if (cached !== undefined) {
    blobCache.delete(ref.sha256);
    blobCache.set(ref.sha256, cached);
    return cached.length === ref.chars ? cached : null;
  }
  const content = await fs.readFile(toolResultBlobPath(ref.sha256), "utf8").catch(() => null);
  if (content === null || content.length !== ref.chars) {
    return null;
  }
  rememberBlob(ref.sha256, content);
  return content;
}

/** What a blob-backed event stores as `detail` (tool rows render it until the full output is loaded). */
export function toolResultPreview(content: string): string {
  const omitted = content.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS;
  if (omitted <= 0) {
    return content;
  }
  return `${content.slice(0, PREVIEW_HEAD_CHARS)}${truncationMarker(omitted)}${content.slice(-PREVIEW_TAIL_CHARS)}`;
}

export function toolResultBlobRef(event: AgentStoredEvent): CesiumToolResultBlobRef | null {
  if (event.kind !== "tool_call_update" || !event.raw || typeof event.raw !== "object") {
    return null;
  }
  const ref = (event.raw as { blobRef?: unknown }).blobRef;
  if (!ref || typeof ref !== "object") {
    return null;
  }
  const { sha256, chars } = ref as { sha256?: unknown; chars?: unknown };
  return isSha256(sha256) && typeof chars === "number" ? { sha256, chars } : null;
}

/**
 * Swaps each blob-backed preview for the full result, so history rebuilt from
 * the log carries exactly what the live request did. A missing blob leaves
 * the preview in place. Never mutates the given events.
 */
export async function hydrateToolResultBlobs(events: AgentStoredEvent[]): Promise<AgentStoredEvent[]> {
  if (!events.some((event) => toolResultBlobRef(event))) {
    return events;
  }
  return Promise.all(
    events.map(async (event) => {
      const ref = toolResultBlobRef(event);
      if (!ref) {
        return event;
      }
      const content = await readToolResultBlob(ref);
      return content === null ? event : ({ ...event, detail: content } as AgentStoredEvent);
    })
  );
}
