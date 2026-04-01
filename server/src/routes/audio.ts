import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const audioRoutes = new Hono();

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

  const baseUrl = (
    process.env.OPENCURSOR_TRANSCRIPTION_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    ""
  ).trim();
  const apiKey = (
    process.env.OPENCURSOR_TRANSCRIPTION_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.GROQ_API_KEY ??
    ""
  ).trim();
  const model = (
    process.env.OPENCURSOR_TRANSCRIPTION_MODEL ??
    ""
  ).trim();

  if (!baseUrl || !apiKey || !model) {
    return c.json(
      {
        error:
          "Speech transcription is not configured. Set OPENCURSOR_TRANSCRIPTION_BASE_URL, OPENCURSOR_TRANSCRIPTION_API_KEY, and OPENCURSOR_TRANSCRIPTION_MODEL.",
      },
      503
    );
  }

  const language =
    (typeof body.language === "string" ? body.language : process.env.OPENCURSOR_TRANSCRIPTION_LANGUAGE)?.trim() ||
    undefined;
  const prompt =
    (typeof body.prompt === "string" ? body.prompt : process.env.OPENCURSOR_TRANSCRIPTION_PROMPT)?.trim() ||
    undefined;

  const upstream = new URL(
    "audio/transcriptions",
    normalizeBaseUrl(baseUrl)
  ).toString();
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
    new File([await file.arrayBuffer()], file.name || "recording.webm", {
      type: file.type || "audio/webm",
    })
  );

  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
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
