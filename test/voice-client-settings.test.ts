import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { isSecretEnvelope } from "../packages/core/src/secret-envelope.ts";
import {
  applyCloudVoiceSecrets,
  clearVoiceClientSettings,
  createMemoryKeyValueStore,
  getClientPlatform,
  getVoiceSecretsForCloud,
  loadVoiceClientSettings,
  saveVoiceClientSettings,
  setClientPlatform,
  toPublicVoiceClientSettings,
  VOICE_CLIENT_SETTINGS_STORAGE_KEY,
} from "../packages/client/src/index.ts";

const originalPlatform = getClientPlatform();

function useMemoryStore() {
  const store = createMemoryKeyValueStore();
  setClientPlatform({
    ...originalPlatform,
    keyValueStore: store,
    emitEvent: () => undefined,
    addEventListener: () => () => undefined,
  });
  return store;
}

afterEach(() => {
  setClientPlatform(originalPlatform);
});

describe("account voice settings", () => {
  test("saves without a server and seals the API key at rest", async () => {
    const store = useMemoryStore();
    const saved = await saveVoiceClientSettings({
      preferredSource: "client",
      transcription: {
        baseUrl: "https://infer.example/v1",
        apiKey: "sk-account-secret-key",
        model: "whisper-1",
      },
    });
    assert.equal(saved.transcription?.apiKey, "sk-account-secret-key");
    assert.equal(saved.preferredSource, "client");

    const raw = store.getItem(VOICE_CLIENT_SETTINGS_STORAGE_KEY);
    assert.ok(raw);
    assert.equal(raw.includes("sk-account-secret-key"), false);
    const parsed = JSON.parse(raw) as { transcription?: { apiKey?: string } };
    assert.equal(isSecretEnvelope(parsed.transcription?.apiKey ?? ""), true);

    const publicSettings = toPublicVoiceClientSettings(await loadVoiceClientSettings());
    assert.equal(publicSettings.transcription.configured, true);
    assert.equal(publicSettings.transcription.apiKeyLastFour, "-key");
    assert.equal(JSON.stringify(publicSettings).includes("sk-account-secret-key"), false);
  });

  test("cloud reconcile prefers newer account copy", async () => {
    useMemoryStore();
    await saveVoiceClientSettings({
      transcription: {
        baseUrl: "https://local.example/v1",
        apiKey: "local-key",
        model: "whisper-1",
      },
    });
    applyCloudVoiceSecrets([
      {
        kind: "voice.settings",
        updatedAt: 1,
        payload: JSON.stringify({
          schemaVersion: 1,
          updatedAt: 1,
          preferredSource: "auto",
          transcription: {
            baseUrl: "https://stale.example/v1",
            model: "old-whisper",
          },
        }),
      },
    ]);
    const current = await loadVoiceClientSettings();
    assert.equal(current.transcription?.baseUrl, "https://local.example/v1");
  });

  test("clear keeps the preferred source", async () => {
    useMemoryStore();
    await saveVoiceClientSettings({
      preferredSource: "server",
      transcription: {
        baseUrl: "https://local.example/v1",
        apiKey: "local-key",
        model: "whisper-1",
      },
    });
    const cleared = await clearVoiceClientSettings();
    assert.equal(cleared.preferredSource, "server");
    assert.equal(cleared.transcription, undefined);
    const secrets = getVoiceSecretsForCloud();
    assert.ok(secrets.some((record) => record.kind === "wrapping-key"));
    assert.ok(secrets.some((record) => record.kind === "voice.settings"));
  });
});
