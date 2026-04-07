import type { ContentfulStatusCode } from "hono/utils/http-status";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  toFile,
} from "openai";

const DEFAULT_OPENAI_TRANSCRIPTION_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GROQ_TRANSCRIPTION_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT = "text";

export type AudioTranscriptionRequest = {
  file: File;
  language?: string;
  prompt?: string;
};

export type ResolvedAudioTranscriptionConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  language?: string;
  prompt?: string;
  responseFormat: string;
  organization?: string;
  project?: string;
  timeout?: number;
};

export class AudioTranscriptionError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(message: string, status: ContentfulStatusCode) {
    super(message);
    this.name = "AudioTranscriptionError";
    this.status = status;
  }
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseOptionalPositiveInteger(name: string): number | undefined {
  const raw = readTrimmedEnv(name);
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function providerLooksLikeGroq(baseURL: string | undefined): boolean {
  return typeof baseURL === "string" && /(?:^|\.)groq\.com(?:\/|$)/i.test(baseURL);
}

function normalizeTranscriptionProviderStatus(status: number | undefined): ContentfulStatusCode {
  if (typeof status === "number" && status >= 400 && status < 600) {
    return status as ContentfulStatusCode;
  }
  return 502;
}

function readProviderErrorMessage(error: APIError): string {
  const nestedMessage =
    error.error &&
    typeof error.error === "object" &&
    "message" in error.error &&
    typeof error.error.message === "string"
      ? error.error.message.trim()
      : "";
  return nestedMessage || error.message || "Transcription provider request failed.";
}

function extractTranscriptionText(response: unknown): string {
  if (typeof response === "string") {
    return response.trim();
  }
  const text =
    response && typeof response === "object" && "text" in response
      ? (response as { text?: unknown }).text
      : undefined;
  return typeof text === "string" ? text.trim() : "";
}

export function resolveAudioTranscriptionConfig(): ResolvedAudioTranscriptionConfig {
  const explicitBaseURL =
    readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_BASE_URL") ??
    readTrimmedEnv("OPENAI_BASE_URL");
  const explicitApiKey =
    readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_API_KEY") ??
    readTrimmedEnv("OPENAI_API_KEY");
  const groqApiKey = readTrimmedEnv("GROQ_API_KEY");

  const apiKey = explicitApiKey ?? groqApiKey;
  if (!apiKey) {
    throw new AudioTranscriptionError(
      "Speech transcription is not configured. Set OPENCURSOR_TRANSCRIPTION_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY.",
      503
    );
  }

  const preferGroq =
    providerLooksLikeGroq(explicitBaseURL) ||
    (!explicitApiKey && Boolean(groqApiKey));
  const baseURL =
    explicitBaseURL ??
    (preferGroq
      ? DEFAULT_GROQ_TRANSCRIPTION_BASE_URL
      : DEFAULT_OPENAI_TRANSCRIPTION_BASE_URL);
  const model =
    readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_MODEL") ??
    (preferGroq
      ? DEFAULT_GROQ_TRANSCRIPTION_MODEL
      : DEFAULT_OPENAI_TRANSCRIPTION_MODEL);

  return {
    apiKey,
    baseURL,
    model,
    language: readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_LANGUAGE"),
    prompt: readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_PROMPT"),
    responseFormat:
      readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_RESPONSE_FORMAT") ??
      DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT,
    organization: readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_ORGANIZATION"),
    project: readTrimmedEnv("OPENCURSOR_TRANSCRIPTION_PROJECT"),
    timeout: parseOptionalPositiveInteger("OPENCURSOR_TRANSCRIPTION_TIMEOUT_MS"),
  };
}

export async function transcribeAudioUpload({
  file,
  language,
  prompt,
}: AudioTranscriptionRequest): Promise<string> {
  const config = resolveAudioTranscriptionConfig();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    organization: config.organization,
    project: config.project,
    timeout: config.timeout,
  });

  try {
    const response = await client.audio.transcriptions.create({
      file: await toFile(
        await file.arrayBuffer(),
        file.name || "recording.webm",
        {
          type: file.type || "audio/webm",
        }
      ),
      model: config.model,
      language: language?.trim() || config.language,
      prompt: prompt?.trim() || config.prompt,
      response_format: config.responseFormat as
        | "json"
        | "text"
        | "srt"
        | "verbose_json"
        | "vtt"
        | "diarized_json",
    });
    const text = extractTranscriptionText(response);
    if (!text) {
      throw new AudioTranscriptionError(
        "Transcription provider returned no text.",
        502
      );
    }
    return text;
  } catch (error) {
    if (error instanceof AudioTranscriptionError) {
      throw error;
    }
    if (error instanceof APIConnectionTimeoutError) {
      throw new AudioTranscriptionError(
        "Timed out while contacting the transcription provider.",
        504
      );
    }
    if (error instanceof APIConnectionError) {
      throw new AudioTranscriptionError(
        "Could not reach the transcription provider.",
        502
      );
    }
    if (error instanceof APIError) {
      throw new AudioTranscriptionError(
        readProviderErrorMessage(error),
        normalizeTranscriptionProviderStatus(error.status)
      );
    }
    throw new AudioTranscriptionError(
      error instanceof Error
        ? error.message
        : "Transcription provider request failed.",
      502
    );
  }
}
