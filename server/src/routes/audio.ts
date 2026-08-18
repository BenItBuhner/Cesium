import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { transcriptionProcessEnv } from "../lib/transcription-env.js";
import {
  fetchTranscriptionWithRetry,
  resolveTranscriptionRetryConfig,
} from "../lib/transcription-retry.js";
import { ensureCesiumDirGitignored } from "../lib/artifacts/store.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { resolveSafePath } from "../lib/workspace.js";

export const audioRoutes = new Hono();

/**
 * Failed voice recordings the user chose to keep live in a temporary dir
 * under the workspace-local `.cesium/` data root (auto-gitignored), so they
 * can be re-transcribed or downloaded later.
 */
export const VOICE_RECORDINGS_DIR = ".cesium/tmp/recordings";

function firstBodyFile(
  value: string | File | (string | File)[] | undefined
): File | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const candidate = value.find((entry): entry is File => entry instanceof File);
    return candidate ?? null;
  }
  return value instanceof File ? value : null;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

audioRoutes.post("/api/audio/transcriptions", async (c) => {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }

  const file = firstBodyFile(body.file);
  if (!file) {
    return c.json({ error: "Expected audio file upload." }, 400);
  }

  const { baseUrl, apiKey, model, language: configuredLanguage, prompt: configuredPrompt } =
    transcriptionProcessEnv();

  if (!baseUrl || !apiKey || !model) {
    return c.json(
      {
        error:
          "Speech transcription is not configured. Open Settings → Voice to set a base URL, API key, and model, or set OPENCURSOR_TRANSCRIPTION_* environment variables.",
      },
      503
    );
  }

  const language =
    (typeof body.language === "string" ? body.language : configuredLanguage)?.trim() ||
    undefined;
  const prompt =
    (typeof body.prompt === "string" ? body.prompt : configuredPrompt)?.trim() ||
    undefined;

  const upstream = new URL(
    "audio/transcriptions",
    normalizeBaseUrl(baseUrl)
  ).toString();
  const audioBytes = await file.arrayBuffer();
  const buildForm = () => {
    const form = new FormData();
    form.set("model", model);
    if (language) {
      form.set("language", language);
    }
    if (prompt) {
      form.set("prompt", prompt);
    }
    form.set("response_format", "json");
    form.set(
      "file",
      new File([audioBytes], file.name || "recording.webm", {
        type: file.type || "audio/webm",
      })
    );
    return form;
  };

  const retryConfig = resolveTranscriptionRetryConfig();
  let response: Response;
  try {
    ({ response } = await fetchTranscriptionWithRetry(
      () =>
        fetch(upstream, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: buildForm(),
        }),
      retryConfig
    ));
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Transcription provider request failed.",
      },
      502
    );
  }
  const rawText = await response.text();
  if (!response.ok) {
    let parsedError = "";
    try {
      const payload = JSON.parse(rawText) as
        | { error?: string | { message?: string } }
        | null;
      if (typeof payload?.error === "string") {
        parsedError = payload.error;
      } else if (payload?.error && typeof payload.error.message === "string") {
        parsedError = payload.error.message;
      }
    } catch {
      parsedError = "";
    }
    return c.json(
      {
        error: parsedError || rawText || "Transcription provider request failed.",
      },
      (response.status >= 400 && response.status < 600 ? response.status : 502) as ContentfulStatusCode
    );
  }

  let payload: unknown = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  const text =
    typeof (payload as { text?: unknown } | null)?.text === "string"
      ? (payload as { text: string }).text.trim()
      : "";
  if (!text) {
    return c.json({ error: "Transcription provider returned no text." }, 502);
  }

  return c.json({ text });
});

function recordingExtension(file: File): string {
  const fromName = path.extname(file.name || "").toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) {
    return fromName;
  }
  const type = (file.type || "").toLowerCase();
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  return ".webm";
}

audioRoutes.post("/api/audio/recordings", async (c) => {
  let workspace;
  try {
    workspace = await requireWorkspaceFromRequest(c);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown workspace." },
      400
    );
  }

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }

  const file = firstBodyFile(body.file);
  if (!file) {
    return c.json({ error: "Expected audio file upload." }, 400);
  }

  const recordingsDir = path.join(workspace.root, VOICE_RECORDINGS_DIR);
  await fs.mkdir(recordingsDir, { recursive: true });
  await ensureCesiumDirGitignored(workspace.root).catch(() => undefined);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const extension = recordingExtension(file);
  let fileName = `voice-recording-${stamp}${extension}`;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    try {
      await fs.access(path.join(recordingsDir, fileName));
    } catch {
      break;
    }
    fileName = `voice-recording-${stamp}-${attempt}${extension}`;
  }

  const relativePath = path.posix.join(VOICE_RECORDINGS_DIR, fileName);
  const absolutePath = resolveSafePath(workspace.root, relativePath);
  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(absolutePath, bytes);

  return c.json({ path: relativePath, name: fileName, size: bytes.byteLength });
});
