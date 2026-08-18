import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-voice-speech-settings-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.GROQ_API_KEY;
delete process.env.CESIUM_BASE_URL;
delete process.env.CESIUM_API_KEY;
delete process.env.CESIUM_DEFAULT_MODEL;
delete process.env.OPENCURSOR_TRANSCRIPTION_BASE_URL;
delete process.env.OPENCURSOR_TRANSCRIPTION_API_KEY;
delete process.env.OPENCURSOR_TRANSCRIPTION_MODEL;
delete process.env.OPENCURSOR_TRANSCRIPTION_LANGUAGE;
delete process.env.OPENCURSOR_TRANSCRIPTION_PROMPT;
delete process.env.OPENCURSOR_TITLE_MODEL;
delete process.env.OPENCURSOR_VOICE_BASE_URL;
delete process.env.OPENCURSOR_VOICE_API_KEY;
delete process.env.OPENCURSOR_VOICE_MODEL;
delete process.env.OPENCURSOR_VOICE_TTS_BASE_URL;
delete process.env.OPENCURSOR_VOICE_TTS_API_KEY;
delete process.env.OPENCURSOR_VOICE_TTS_MODEL;
delete process.env.OPENCURSOR_VOICE_TTS_VOICE;
delete process.env.OPENCURSOR_VOICE_TTS_ENGINE;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [
  { settingsRoutes },
  {
    invalidateVoiceSpeechSettingsCache,
    patchVoiceSpeechSettings,
    deleteVoiceSpeechSettings,
  },
  { transcriptionProcessEnv, titleGenerationProcessEnv, isTranscriptionConfigured },
  { voiceControllerEnv },
  { resolveOpenAiTtsConfig, resolveTtsEnginePreference },
  { getVoiceSpeechSettingsPublic },
] = await Promise.all([
  import("../src/routes/settings.js"),
  import("../src/lib/voice-speech-settings.js"),
  import("../src/lib/transcription-env.js"),
  import("../src/lib/voice/voice-env.js"),
  import("../src/lib/voice/tts/settings-resolve.js"),
  import("../src/lib/voice-speech-resolve.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("env-only transcription still resolves when nothing is stored", () => {
  invalidateVoiceSpeechSettingsCache();
  const resolved = transcriptionProcessEnv({
    OPENCURSOR_TRANSCRIPTION_BASE_URL: "https://api.groq.com/openai/v1",
    OPENCURSOR_TRANSCRIPTION_API_KEY: "gsk-test",
    OPENCURSOR_TRANSCRIPTION_MODEL: "whisper-large-v3",
  } as NodeJS.ProcessEnv);
  assert.equal(resolved.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(resolved.apiKey, "gsk-test");
  assert.equal(resolved.model, "whisper-large-v3");
  assert.equal(isTranscriptionConfigured({} as NodeJS.ProcessEnv), false);
});

test("stored transcription settings override environment variables", async () => {
  process.env.OPENCURSOR_TRANSCRIPTION_BASE_URL = "https://env.example/v1";
  process.env.OPENCURSOR_TRANSCRIPTION_API_KEY = "env-key";
  process.env.OPENCURSOR_TRANSCRIPTION_MODEL = "env-whisper";
  process.env.OPENCURSOR_TRANSCRIPTION_LANGUAGE = "fr";
  try {
    await patchVoiceSpeechSettings({
      transcription: {
        baseUrl: "https://stored.example/v1",
        apiKey: "stored-key-1234",
        model: "whisper-large-v3-turbo",
        language: "en",
        prompt: "Prefer identifiers",
      },
    });
    const resolved = transcriptionProcessEnv();
    assert.equal(resolved.baseUrl, "https://stored.example/v1");
    assert.equal(resolved.apiKey, "stored-key-1234");
    assert.equal(resolved.model, "whisper-large-v3-turbo");
    assert.equal(resolved.language, "en");
    assert.equal(resolved.prompt, "Prefer identifiers");
    assert.equal(isTranscriptionConfigured(), true);
  } finally {
    await deleteVoiceSpeechSettings();
    delete process.env.OPENCURSOR_TRANSCRIPTION_BASE_URL;
    delete process.env.OPENCURSOR_TRANSCRIPTION_API_KEY;
    delete process.env.OPENCURSOR_TRANSCRIPTION_MODEL;
    delete process.env.OPENCURSOR_TRANSCRIPTION_LANGUAGE;
  }
});

test("title generation uses stored model and shared transcription credentials", async () => {
  await patchVoiceSpeechSettings({
    transcription: {
      baseUrl: "https://titles.example/v1",
      apiKey: "title-key",
      model: "whisper-large-v3",
    },
    titleGeneration: { model: "stored/title-model" },
  });
  try {
    const title = titleGenerationProcessEnv();
    assert.equal(title.baseUrl, "https://titles.example/v1");
    assert.equal(title.apiKey, "title-key");
    assert.equal(title.titleModel, "stored/title-model");
  } finally {
    await deleteVoiceSpeechSettings();
  }
});

test("stored voice controller and TTS settings override env", async () => {
  process.env.OPENCURSOR_VOICE_BASE_URL = "https://env-voice.example/v1";
  process.env.OPENCURSOR_VOICE_API_KEY = "env-voice-key";
  process.env.OPENCURSOR_VOICE_MODEL = "env-voice";
  process.env.OPENCURSOR_VOICE_TTS_BASE_URL = "https://env-tts.example/v1";
  process.env.OPENCURSOR_VOICE_TTS_API_KEY = "env-tts-key";
  try {
    await patchVoiceSpeechSettings({
      controller: {
        baseUrl: "https://stored-voice.example/v1/",
        apiKey: "stored-voice-key",
        model: "kimi-k3",
      },
      tts: {
        engine: "openai-compatible",
        openaiCompat: {
          baseUrl: "https://stored-tts.example/v1",
          apiKey: "stored-tts-key",
          model: "tts-1-hd",
          voice: "verse",
        },
      },
    });
    const controller = voiceControllerEnv();
    assert.equal(controller.baseUrl, "https://stored-voice.example/v1");
    assert.equal(controller.apiKey, "stored-voice-key");
    assert.equal(controller.model, "kimi-k3");

    const tts = resolveOpenAiTtsConfig();
    assert.ok(tts);
    assert.equal(tts.baseUrl, "https://stored-tts.example/v1");
    assert.equal(tts.apiKey, "stored-tts-key");
    assert.equal(tts.model, "tts-1-hd");
    assert.equal(tts.voice, "verse");
    assert.equal(resolveTtsEnginePreference().value, "openai-compatible");
    assert.equal(resolveTtsEnginePreference().source, "stored");
  } finally {
    await deleteVoiceSpeechSettings();
    delete process.env.OPENCURSOR_VOICE_BASE_URL;
    delete process.env.OPENCURSOR_VOICE_API_KEY;
    delete process.env.OPENCURSOR_VOICE_MODEL;
    delete process.env.OPENCURSOR_VOICE_TTS_BASE_URL;
    delete process.env.OPENCURSOR_VOICE_TTS_API_KEY;
  }
});

test("public voice settings redact API keys and expose sources", async () => {
  await patchVoiceSpeechSettings({
    transcription: {
      baseUrl: "https://secret.example/v1",
      apiKey: "super-secret-key",
      model: "whisper-large-v3",
    },
  });
  try {
    const publicSettings = await getVoiceSpeechSettingsPublic();
    assert.equal(publicSettings.transcription.configured, true);
    assert.equal(publicSettings.transcription.source, "stored");
    assert.equal(publicSettings.transcription.apiKeyLastFour, "-key");
    assert.equal(
      JSON.stringify(publicSettings).includes("super-secret-key"),
      false
    );
  } finally {
    await deleteVoiceSpeechSettings();
  }
});

test("voice settings HTTP routes persist and clear stored values", async () => {
  const put = await settingsRoutes.request("/api/settings/voice", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcription: {
        baseUrl: "https://http.example/v1",
        apiKey: "http-secret-key",
        model: "whisper-large-v3",
        language: "en",
      },
    }),
  });
  assert.equal(put.status, 200);
  const putBody = (await put.json()) as {
    settings: { transcription: { model?: string; apiKeyLastFour?: string; configured: boolean } };
  };
  assert.equal(putBody.settings.transcription.configured, true);
  assert.equal(putBody.settings.transcription.model, "whisper-large-v3");
  assert.equal(putBody.settings.transcription.apiKeyLastFour, "-key");

  const get = await settingsRoutes.request("/api/settings/voice");
  assert.equal(get.status, 200);
  const getBody = (await get.json()) as {
    settings: { transcription: { baseUrl?: string } };
  };
  assert.equal(getBody.settings.transcription.baseUrl, "https://http.example/v1");

  const del = await settingsRoutes.request("/api/settings/voice", { method: "DELETE" });
  assert.equal(del.status, 200);
  const delBody = (await del.json()) as {
    settings: { transcription: { configured: boolean; source: string | null } };
  };
  assert.equal(delBody.settings.transcription.configured, false);
});
