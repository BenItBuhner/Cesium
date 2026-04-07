import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { afterEach, test } from "node:test";
import { Hono } from "hono";
import {
  resolveAudioTranscriptionConfig,
} from "../src/lib/audio-transcription.js";
import { audioRoutes } from "../src/routes/audio.js";

const transcriptionEnvKeys = [
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_MODEL",
  "OPENCURSOR_TRANSCRIPTION_LANGUAGE",
  "OPENCURSOR_TRANSCRIPTION_PROMPT",
  "OPENCURSOR_TRANSCRIPTION_RESPONSE_FORMAT",
  "OPENCURSOR_TRANSCRIPTION_TIMEOUT_MS",
  "OPENCURSOR_TRANSCRIPTION_ORGANIZATION",
  "OPENCURSOR_TRANSCRIPTION_PROJECT",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
] as const;

const originalTranscriptionEnv = Object.fromEntries(
  transcriptionEnvKeys.map((key) => [key, process.env[key]])
) as Record<(typeof transcriptionEnvKeys)[number], string | undefined>;

const app = new Hono();
app.route("/", audioRoutes);

function restoreTranscriptionEnv(): void {
  for (const key of transcriptionEnvKeys) {
    const originalValue = originalTranscriptionEnv[key];
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

function applyTranscriptionEnv(
  overrides: Partial<Record<(typeof transcriptionEnvKeys)[number], string | undefined>>
): void {
  restoreTranscriptionEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createAudioUploadForm(
  extra?: Record<string, string>
): FormData {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array([0, 1, 2, 3])], "clip.webm", {
      type: "audio/webm",
    })
  );
  for (const [key, value] of Object.entries(extra ?? {})) {
    form.set(key, value);
  }
  return form;
}

function headersFromIncomingMessage(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
      continue;
    }
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

async function parseMultipartFormData(request: IncomingMessage): Promise<FormData> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const webRequest = new Request("http://127.0.0.1/mock", {
    method: request.method,
    headers: headersFromIncomingMessage(request),
    body: Buffer.concat(chunks),
  });
  return webRequest.formData();
}

async function createMockTranscriptionServer(
  handler: (request: IncomingMessage, form: FormData) => Promise<{
    status?: number;
    headers?: Record<string, string>;
    body: string;
  }>
): Promise<{
  baseURL: string;
  close: () => Promise<void>;
}> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
      response.writeHead(404).end("Not found");
      return;
    }
    const form = await parseMultipartFormData(request);
    const result = await handler(request, form);
    response.writeHead(result.status ?? 200, {
      "content-type": "text/plain; charset=utf-8",
      ...(result.headers ?? {}),
    });
    response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock transcription server to bind an ephemeral TCP port.");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

afterEach(() => {
  restoreTranscriptionEnv();
});

test("resolveAudioTranscriptionConfig defaults to Groq when only GROQ_API_KEY is set", () => {
  applyTranscriptionEnv({
    GROQ_API_KEY: "gsk_test_value",
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENCURSOR_TRANSCRIPTION_API_KEY: undefined,
    OPENCURSOR_TRANSCRIPTION_BASE_URL: undefined,
    OPENCURSOR_TRANSCRIPTION_MODEL: undefined,
  });

  const config = resolveAudioTranscriptionConfig();
  assert.equal(config.apiKey, "gsk_test_value");
  assert.equal(config.baseURL, "https://api.groq.com/openai/v1");
  assert.equal(config.model, "whisper-large-v3-turbo");
  assert.equal(config.responseFormat, "text");
});

test("audio transcription route uploads audio to an OpenAI-compatible upstream and returns text", async () => {
  let observedAuthorization = "";
  let observedModel = "";
  let observedLanguage = "";
  let observedPrompt = "";
  let observedFileName = "";

  const mockServer = await createMockTranscriptionServer(async (request, form) => {
    observedAuthorization = request.headers.authorization ?? "";
    observedModel = String(form.get("model") ?? "");
    observedLanguage = String(form.get("language") ?? "");
    observedPrompt = String(form.get("prompt") ?? "");
    const uploaded = form.get("file");
    assert.ok(uploaded instanceof File, "expected upstream upload to include a File");
    observedFileName = uploaded.name;
    return {
      body: "transcribed from mock upstream",
    };
  });

  try {
    applyTranscriptionEnv({
      OPENCURSOR_TRANSCRIPTION_BASE_URL: mockServer.baseURL,
      OPENCURSOR_TRANSCRIPTION_API_KEY: "test-secret",
      OPENCURSOR_TRANSCRIPTION_MODEL: "mock-whisper",
      OPENCURSOR_TRANSCRIPTION_RESPONSE_FORMAT: "text",
      GROQ_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
    });

    const response = await app.request("/api/audio/transcriptions", {
      method: "POST",
      body: createAudioUploadForm({
        language: "en",
        prompt: "Please transcribe this clip cleanly.",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "transcribed from mock upstream",
    });
    assert.equal(observedAuthorization, "Bearer test-secret");
    assert.equal(observedModel, "mock-whisper");
    assert.equal(observedLanguage, "en");
    assert.equal(observedPrompt, "Please transcribe this clip cleanly.");
    assert.equal(observedFileName, "clip.webm");
  } finally {
    await mockServer.close();
  }
});

test("audio transcription route forwards provider errors with useful messages", async () => {
  const mockServer = await createMockTranscriptionServer(async () => ({
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      error: {
        message: "Provider rate limit reached.",
      },
    }),
  }));

  try {
    applyTranscriptionEnv({
      OPENCURSOR_TRANSCRIPTION_BASE_URL: mockServer.baseURL,
      OPENCURSOR_TRANSCRIPTION_API_KEY: "test-secret",
      OPENCURSOR_TRANSCRIPTION_MODEL: "mock-whisper",
      OPENCURSOR_TRANSCRIPTION_RESPONSE_FORMAT: "text",
      GROQ_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
    });

    const response = await app.request("/api/audio/transcriptions", {
      method: "POST",
      body: createAudioUploadForm(),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: "Provider rate limit reached.",
    });
  } finally {
    await mockServer.close();
  }
});

test("audio transcription route returns 503 when provider credentials are missing", async () => {
  applyTranscriptionEnv({
    OPENCURSOR_TRANSCRIPTION_BASE_URL: undefined,
    OPENCURSOR_TRANSCRIPTION_API_KEY: undefined,
    OPENCURSOR_TRANSCRIPTION_MODEL: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    GROQ_API_KEY: undefined,
  });

  const response = await app.request("/api/audio/transcriptions", {
    method: "POST",
    body: createAudioUploadForm(),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error:
      "Speech transcription is not configured. Set OPENCURSOR_TRANSCRIPTION_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY.",
  });
});
