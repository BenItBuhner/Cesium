import {
  isVoiceClientTranscriptionConfigured,
  loadVoiceClientSettings,
} from "./voice-client-settings";
import { transcribeAudioOnServer, type AudioTranscriptionResult } from "./server-api";

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (
      payload.error &&
      typeof payload.error === "object" &&
      typeof payload.error.message === "string"
    ) {
      return payload.error.message;
    }
  } catch {
    // Use raw body.
  }
  return text.trim() || `Transcription failed (${response.status}).`;
}

async function parseTranscriptionResponse(response: Response): Promise<AudioTranscriptionResult> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = (await response.json()) as { text?: unknown };
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new Error("Transcription provider returned no text.");
  }
  return { text };
}

async function transcribeWithClientCredentials(
  file: File,
  options?: { language?: string; prompt?: string; signal?: AbortSignal }
): Promise<AudioTranscriptionResult> {
  const settings = await loadVoiceClientSettings();
  const transcription = settings.transcription;
  if (
    !transcription?.baseUrl ||
    !transcription.apiKey ||
    !transcription.model
  ) {
    throw new Error(
      "Account speech settings are not configured. Open Settings → Voice and save a client provider."
    );
  }

  const language = options?.language?.trim() || transcription.language;
  const prompt = options?.prompt?.trim() || transcription.prompt;
  const buildForm = () => {
    const form = new FormData();
    form.set("file", file);
    form.set("model", transcription.model!);
    form.set("response_format", "json");
    if (language) {
      form.set("language", language);
    }
    if (prompt) {
      form.set("prompt", prompt);
    }
    return form;
  };

  const upstream = new URL(
    "audio/transcriptions",
    normalizeBaseUrl(transcription.baseUrl)
  ).toString();

  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${transcription.apiKey}` },
      body: buildForm(),
      cache: "no-store",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return await parseTranscriptionResponse(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
  }

  const response = await fetch("/api/audio/transcriptions", {
    method: "POST",
    headers: {
      "X-Cesium-Provider-Base": transcription.baseUrl,
      "X-Cesium-Provider-Key": transcription.apiKey,
      "X-Cesium-Provider-Model": transcription.model,
    },
    body: buildForm(),
    cache: "no-store",
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return parseTranscriptionResponse(response);
}

export async function transcribeAudioResolved(
  file: File,
  options?: { language?: string; prompt?: string; signal?: AbortSignal }
): Promise<AudioTranscriptionResult> {
  const client = await loadVoiceClientSettings();
  const clientReady = isVoiceClientTranscriptionConfigured(client);
  const preferred = client.preferredSource;

  const tryServer = () => transcribeAudioOnServer(file, options);
  const tryClient = () => transcribeWithClientCredentials(file, options);

  if (preferred === "client") {
    if (clientReady) {
      return tryClient();
    }
    return tryServer();
  }

  if (preferred === "server") {
    try {
      return await tryServer();
    } catch (error) {
      if (clientReady) {
        return tryClient();
      }
      throw error;
    }
  }

  if (clientReady && preferred === "auto") {
    try {
      return await tryServer();
    } catch {
      return tryClient();
    }
  }

  try {
    return await tryServer();
  } catch (error) {
    if (clientReady) {
      return tryClient();
    }
    throw error;
  }
}
