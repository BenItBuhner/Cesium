import { getCloudAgentConnection } from "./settings.js";
import type { CloudAgentMediaRef, CloudAgentProviderId } from "./types.js";

/** Prompt attachment shape accepted by the agent runtime. */
export type CloudAgentPromptAttachment = {
  mimeType: string;
  data: string;
  name?: string;
};

export const CLOUD_AGENT_MAX_ATTACHMENTS = 4;
export const CLOUD_AGENT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const MEDIA_EXTENSION_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

function isMediaMime(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}

function guessMimeFromUrl(url: string): string | undefined {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url);
  const ext = match?.[1]?.toLowerCase();
  return ext ? MEDIA_EXTENSION_MIMES[ext] : undefined;
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").filter(Boolean).at(-1);
    return base ? decodeURIComponent(base) : undefined;
  } catch {
    return undefined;
  }
}

function dedupeRefs(refs: CloudAgentMediaRef[]): CloudAgentMediaRef[] {
  const seen = new Set<string>();
  const out: CloudAgentMediaRef[] = [];
  for (const ref of refs) {
    if (!ref.url || seen.has(ref.url)) {
      continue;
    }
    seen.add(ref.url);
    out.push(ref);
  }
  return out;
}

/**
 * Extracts image/video references from a markdown body: `![alt](url)` images,
 * HTML `<img>`/`<video>` tags, and bare attachment-host URLs (GitHub
 * user-attachments, Linear uploads).
 */
export function extractMarkdownMediaRefs(body: string): CloudAgentMediaRef[] {
  const refs: CloudAgentMediaRef[] = [];
  if (!body) {
    return refs;
  }

  const markdownImages = body.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g);
  for (const match of markdownImages) {
    refs.push({
      url: match[2]!,
      ...(match[1]?.trim() ? { name: match[1]!.trim() } : {}),
    });
  }

  const htmlMedia = body.matchAll(
    /<(?:img|video|source)\b[^>]*?src=["'](https?:\/\/[^"']+)["'][^>]*>/gi
  );
  for (const match of htmlMedia) {
    refs.push({ url: match[1]! });
  }

  // Bare attachment-host links (GitHub drag-and-drop uploads and Linear
  // uploads often appear as plain URLs without markdown image syntax).
  const bareUrls = body.matchAll(
    /https?:\/\/(?:github\.com\/user-attachments\/assets|user-images\.githubusercontent\.com|uploads\.linear\.app|files\.slack\.com)[^\s)>\]"']*/g
  );
  for (const match of bareUrls) {
    refs.push({ url: match[0]! });
  }

  return dedupeRefs(refs).map((ref) => ({
    ...ref,
    ...(ref.name ? {} : fileNameFromUrl(ref.url) ? { name: fileNameFromUrl(ref.url) } : {}),
    ...(ref.mimeType
      ? {}
      : guessMimeFromUrl(ref.url)
        ? { mimeType: guessMimeFromUrl(ref.url) }
        : {}),
  }));
}

/**
 * Converts Slack mrkdwn to standard markdown: `<url|label>` links, bare
 * `<url>` links, HTML entities, and Slack's single-character emphasis.
 */
export function normalizeSlackMrkdwn(text: string): string {
  if (!text) {
    return text;
  }
  return (
    text
      // Keep user/channel mentions readable instead of raw ids.
      .replace(/<@([A-Z0-9]+)>/g, "@$1")
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      // Slack bold/strikethrough use single markers; markdown uses doubles.
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, "$1**$2**")
      .replace(/(^|\s)~([^~\n]+)~(?=\s|$|[.,;:!?])/g, "$1~~$2~~")
  );
}

/** Auth headers for provider-hosted attachment URLs (private CDNs). */
export function attachmentAuthHeaders(
  url: string,
  providerId: CloudAgentProviderId | "manual",
  accessToken: string | null
): Record<string, string> {
  if (!accessToken) {
    return {};
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  if (providerId === "slack" && (host === "files.slack.com" || host.endsWith(".slack.com"))) {
    return { Authorization: `Bearer ${accessToken}` };
  }
  if (providerId === "linear" && host === "uploads.linear.app") {
    // Linear personal API keys are sent raw; OAuth tokens as Bearer.
    return {
      Authorization: accessToken.startsWith("lin_api_")
        ? accessToken
        : `Bearer ${accessToken}`,
    };
  }
  if (
    providerId === "github" &&
    (host === "github.com" ||
      host === "user-images.githubusercontent.com" ||
      host.endsWith(".githubusercontent.com"))
  ) {
    return { Authorization: `Bearer ${accessToken}` };
  }
  return {};
}

export type CloudAgentAttachmentFetchResult = {
  attachments: CloudAgentPromptAttachment[];
  /** Human-readable notes about skipped/failed downloads (for task timelines). */
  notes: string[];
};

/**
 * Downloads media references so they can be attached to the agent prompt.
 * Best-effort: failures become notes, never errors. Only image/video content
 * within the size cap is attached; everything else stays a URL in the prompt.
 */
export async function fetchCloudAgentAttachments(
  refs: CloudAgentMediaRef[],
  providerId: CloudAgentProviderId | "manual",
  options?: { fetchImpl?: typeof fetch }
): Promise<CloudAgentAttachmentFetchResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const attachments: CloudAgentPromptAttachment[] = [];
  const notes: string[] = [];
  if (refs.length === 0) {
    return { attachments, notes };
  }

  const connection =
    providerId === "manual" ? null : await getCloudAgentConnection(providerId);
  const limited = dedupeRefs(refs).slice(0, CLOUD_AGENT_MAX_ATTACHMENTS);
  if (refs.length > limited.length) {
    notes.push(
      `Attached the first ${CLOUD_AGENT_MAX_ATTACHMENTS} media files; ${refs.length - limited.length} more remain as URLs in the prompt.`
    );
  }

  for (const ref of limited) {
    const label = ref.name ?? ref.url;
    try {
      const authHeaders = attachmentAuthHeaders(
        ref.url,
        providerId,
        connection?.accessToken ?? null
      );
      let response = await fetchImpl(ref.url, {
        headers: authHeaders,
        redirect: "follow",
      });
      if (!response.ok && Object.keys(authHeaders).length > 0) {
        // Some public CDNs (e.g. raw.githubusercontent.com) reject requests
        // carrying an unexpected Authorization header; retry anonymously.
        response = await fetchImpl(ref.url, { redirect: "follow" });
      }
      if (!response.ok) {
        notes.push(`Could not download ${label} (HTTP ${response.status}).`);
        continue;
      }
      const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      const mimeType = isMediaMime(contentType)
        ? contentType
        : (ref.mimeType && isMediaMime(ref.mimeType) ? ref.mimeType : undefined) ??
          guessMimeFromUrl(ref.url);
      if (!mimeType || !isMediaMime(mimeType)) {
        notes.push(`Skipped ${label}: not an image or video (${contentType || "unknown type"}).`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0) {
        notes.push(`Skipped ${label}: empty response.`);
        continue;
      }
      if (buffer.byteLength > CLOUD_AGENT_MAX_ATTACHMENT_BYTES) {
        notes.push(
          `Skipped ${label}: ${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MB exceeds the ${CLOUD_AGENT_MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB attachment cap.`
        );
        continue;
      }
      attachments.push({
        mimeType,
        data: buffer.toString("base64"),
        name: ref.name ?? fileNameFromUrl(ref.url) ?? "attachment",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Could not download ${label} (${message}).`);
    }
  }

  return { attachments, notes };
}
