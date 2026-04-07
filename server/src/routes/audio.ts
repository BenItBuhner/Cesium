import { Hono } from "hono";
import {
  AudioTranscriptionError,
  transcribeAudioUpload,
} from "../lib/audio-transcription.js";

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

  try {
    const text = await transcribeAudioUpload({
      file,
      language: typeof body.language === "string" ? body.language : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    });
    return c.json({ text });
  } catch (error) {
    if (error instanceof AudioTranscriptionError) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
});
