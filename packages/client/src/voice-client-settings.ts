import { isSecretEnvelope, secretLastFour } from "@cesium/core";
import { clientKeyValueStore, getClientPlatform } from "./platform";
import {
  adoptCloudWrappingKey,
  getOrCreateLocalWrappingKey,
  openCredential,
  readLocalWrappingKey,
  sealCredential,
  SECRET_WRAPPING_KEY_CLOUD_KIND,
} from "./secret-wrapping-key";
import type { VoiceSpeechFieldSource, VoiceSpeechSettingsPayload, VoiceSpeechSettingsPatch } from "./voice-speech-types";

export const VOICE_CLIENT_SETTINGS_STORAGE_KEY = "cesium.voice.client-settings";
export const VOICE_CLIENT_SETTINGS_CLOUD_KIND = "voice.settings";
export const VOICE_CLIENT_SETTINGS_EVENT = "cesium:voice-client-settings";

export type VoiceSettingsSourcePreference = "auto" | "server" | "client";

export type VoiceClientCredentialStored = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type VoiceClientSettings = {
  schemaVersion: 1;
  updatedAt: number;
  preferredSource: VoiceSettingsSourcePreference;
  transcription?: VoiceClientCredentialStored & {
    language?: string;
    prompt?: string;
  };
  titleGeneration?: { model?: string };
  tts?: {
    engine?: string;
    openaiCompat?: VoiceClientCredentialStored & { voice?: string };
  };
  controller?: VoiceClientCredentialStored;
};

const API_KEY_PURPOSES = {
  transcription: "voice.transcription.apiKey",
  tts: "voice.tts.apiKey",
  controller: "voice.controller.apiKey",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickOptionalStrings<K extends string>(
  record: Record<string, unknown> | null,
  keys: readonly K[]
): Partial<Record<K, string>> {
  if (!record) {
    return {};
  }
  const next: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = asOptionalString(record[key]);
    if (value) {
      next[key] = value;
    }
  }
  return next;
}

function normalizePreferredSource(value: unknown): VoiceSettingsSourcePreference {
  return value === "server" || value === "client" || value === "auto" ? value : "auto";
}

function emptySettings(): VoiceClientSettings {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    preferredSource: "auto",
  };
}

export function normalizeVoiceClientSettings(raw: unknown): VoiceClientSettings {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) {
    return emptySettings();
  }
  const transcription = pickOptionalStrings(asRecord(record.transcription), [
    "baseUrl",
    "apiKey",
    "model",
    "language",
    "prompt",
  ] as const);
  const title = pickOptionalStrings(asRecord(record.titleGeneration), ["model"] as const);
  const ttsRecord = asRecord(record.tts);
  const engine = asOptionalString(ttsRecord?.engine);
  const openaiCompat = pickOptionalStrings(asRecord(ttsRecord?.openaiCompat), [
    "baseUrl",
    "apiKey",
    "model",
    "voice",
  ] as const);
  const controller = pickOptionalStrings(asRecord(record.controller), [
    "baseUrl",
    "apiKey",
    "model",
  ] as const);
  return {
    schemaVersion: 1,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : 0,
    preferredSource: normalizePreferredSource(record.preferredSource),
    ...(Object.keys(transcription).length > 0 ? { transcription } : {}),
    ...(Object.keys(title).length > 0 ? { titleGeneration: title } : {}),
    ...(engine || Object.keys(openaiCompat).length > 0
      ? {
          tts: {
            ...(engine ? { engine } : {}),
            ...(Object.keys(openaiCompat).length > 0 ? { openaiCompat } : {}),
          },
        }
      : {}),
    ...(Object.keys(controller).length > 0 ? { controller } : {}),
  };
}

function applyNullableString<K extends string, T extends { [P in K]?: string }>(
  target: T,
  key: K,
  value: string | null | undefined
): void {
  if (value === undefined) {
    return;
  }
  const trimmed = value?.trim();
  if (trimmed) {
    target[key] = trimmed as T[K];
  } else {
    delete target[key];
  }
}

export function mergeVoiceClientPatch(
  current: VoiceClientSettings,
  patch: VoiceSpeechSettingsPatch & { preferredSource?: VoiceSettingsSourcePreference }
): VoiceClientSettings {
  const next: VoiceClientSettings = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    preferredSource: patch.preferredSource ?? current.preferredSource,
    ...(current.transcription ? { transcription: { ...current.transcription } } : {}),
    ...(current.titleGeneration ? { titleGeneration: { ...current.titleGeneration } } : {}),
    ...(current.tts
      ? {
          tts: {
            ...(current.tts.engine ? { engine: current.tts.engine } : {}),
            ...(current.tts.openaiCompat ? { openaiCompat: { ...current.tts.openaiCompat } } : {}),
          },
        }
      : {}),
    ...(current.controller ? { controller: { ...current.controller } } : {}),
  };

  if (patch.transcription) {
    const transcription = { ...(next.transcription ?? {}) };
    applyNullableString(transcription, "baseUrl", patch.transcription.baseUrl);
    applyNullableString(transcription, "apiKey", patch.transcription.apiKey);
    applyNullableString(transcription, "model", patch.transcription.model);
    applyNullableString(transcription, "language", patch.transcription.language);
    applyNullableString(transcription, "prompt", patch.transcription.prompt);
    if (Object.keys(transcription).length > 0) {
      next.transcription = transcription;
    } else {
      delete next.transcription;
    }
  }

  if (patch.titleGeneration) {
    const titleGeneration = { ...(next.titleGeneration ?? {}) };
    applyNullableString(titleGeneration, "model", patch.titleGeneration.model);
    if (Object.keys(titleGeneration).length > 0) {
      next.titleGeneration = titleGeneration;
    } else {
      delete next.titleGeneration;
    }
  }

  if (patch.tts) {
    const tts = { ...(next.tts ?? {}) };
    applyNullableString(tts, "engine", patch.tts.engine);
    if (patch.tts.openaiCompat === null) {
      delete tts.openaiCompat;
    } else if (patch.tts.openaiCompat) {
      const openaiCompat = { ...(tts.openaiCompat ?? {}) };
      applyNullableString(openaiCompat, "baseUrl", patch.tts.openaiCompat.baseUrl);
      applyNullableString(openaiCompat, "apiKey", patch.tts.openaiCompat.apiKey);
      applyNullableString(openaiCompat, "model", patch.tts.openaiCompat.model);
      applyNullableString(openaiCompat, "voice", patch.tts.openaiCompat.voice);
      if (Object.keys(openaiCompat).length > 0) {
        tts.openaiCompat = openaiCompat;
      } else {
        delete tts.openaiCompat;
      }
    }
    if (Object.keys(tts).length > 0) {
      next.tts = tts;
    } else {
      delete next.tts;
    }
  }

  if (patch.controller) {
    const controller = { ...(next.controller ?? {}) };
    applyNullableString(controller, "baseUrl", patch.controller.baseUrl);
    applyNullableString(controller, "apiKey", patch.controller.apiKey);
    applyNullableString(controller, "model", patch.controller.model);
    if (Object.keys(controller).length > 0) {
      next.controller = controller;
    } else {
      delete next.controller;
    }
  }

  return next;
}

async function sealSettings(settings: VoiceClientSettings): Promise<VoiceClientSettings> {
  const next = structuredClone(settings);
  if (next.transcription?.apiKey && !isSecretEnvelope(next.transcription.apiKey)) {
    next.transcription.apiKey = await sealCredential(
      next.transcription.apiKey,
      API_KEY_PURPOSES.transcription
    );
  }
  if (next.tts?.openaiCompat?.apiKey && !isSecretEnvelope(next.tts.openaiCompat.apiKey)) {
    next.tts.openaiCompat.apiKey = await sealCredential(
      next.tts.openaiCompat.apiKey,
      API_KEY_PURPOSES.tts
    );
  }
  if (next.controller?.apiKey && !isSecretEnvelope(next.controller.apiKey)) {
    next.controller.apiKey = await sealCredential(
      next.controller.apiKey,
      API_KEY_PURPOSES.controller
    );
  }
  return next;
}

async function openSettings(settings: VoiceClientSettings): Promise<VoiceClientSettings> {
  const next = structuredClone(settings);
  if (next.transcription?.apiKey) {
    const opened = await openCredential(next.transcription.apiKey, API_KEY_PURPOSES.transcription);
    if (opened) {
      next.transcription.apiKey = opened;
    } else if (isSecretEnvelope(next.transcription.apiKey)) {
      delete next.transcription.apiKey;
    }
  }
  if (next.tts?.openaiCompat?.apiKey) {
    const opened = await openCredential(next.tts.openaiCompat.apiKey, API_KEY_PURPOSES.tts);
    if (opened) {
      next.tts.openaiCompat.apiKey = opened;
    } else if (isSecretEnvelope(next.tts.openaiCompat.apiKey)) {
      delete next.tts.openaiCompat.apiKey;
    }
  }
  if (next.controller?.apiKey) {
    const opened = await openCredential(next.controller.apiKey, API_KEY_PURPOSES.controller);
    if (opened) {
      next.controller.apiKey = opened;
    } else if (isSecretEnvelope(next.controller.apiKey)) {
      delete next.controller.apiKey;
    }
  }
  return next;
}

function readStoredRaw(): VoiceClientSettings {
  const raw = clientKeyValueStore().getItem(VOICE_CLIENT_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return emptySettings();
  }
  try {
    return normalizeVoiceClientSettings(JSON.parse(raw));
  } catch {
    return emptySettings();
  }
}

function writeStoredRaw(settings: VoiceClientSettings): void {
  clientKeyValueStore().setItem(VOICE_CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  getClientPlatform().emitEvent(VOICE_CLIENT_SETTINGS_EVENT);
}

export function readVoiceClientSettingsRaw(): VoiceClientSettings {
  return readStoredRaw();
}

export async function loadVoiceClientSettings(): Promise<VoiceClientSettings> {
  return openSettings(readStoredRaw());
}

export async function saveVoiceClientSettings(
  patch: VoiceSpeechSettingsPatch & { preferredSource?: VoiceSettingsSourcePreference }
): Promise<VoiceClientSettings> {
  const current = await loadVoiceClientSettings();
  const merged = mergeVoiceClientPatch(current, patch);
  writeStoredRaw(await sealSettings(merged));
  return merged;
}

export async function clearVoiceClientSettings(): Promise<VoiceClientSettings> {
  const next: VoiceClientSettings = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    preferredSource: readStoredRaw().preferredSource,
  };
  writeStoredRaw(next);
  return next;
}

export async function setVoicePreferredSource(
  preferredSource: VoiceSettingsSourcePreference
): Promise<VoiceClientSettings> {
  return saveVoiceClientSettings({ preferredSource });
}

function credentialPublic(input: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): VoiceSpeechSettingsPayload["controller"] {
  const configured = Boolean(input.baseUrl && input.apiKey && input.model);
  return {
    configured,
    source: configured || input.baseUrl || input.model || input.apiKey ? "stored" : null,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.apiKey ? { apiKeyLastFour: secretLastFour(input.apiKey) } : {}),
    ...(input.baseUrl ? { baseUrlSource: "stored" } : {}),
    ...(input.model ? { modelSource: "stored" } : {}),
    ...(input.apiKey ? { apiKeySource: "stored" } : {}),
  };
}

export function toPublicVoiceClientSettings(
  settings: VoiceClientSettings
): VoiceSpeechSettingsPayload {
  const transcription = credentialPublic(settings.transcription ?? {});
  const openaiCompat = credentialPublic(settings.tts?.openaiCompat ?? {});
  const controller = credentialPublic(settings.controller ?? {});
  return {
    transcription: {
      ...transcription,
      configured: Boolean(
        settings.transcription?.baseUrl &&
          settings.transcription.apiKey &&
          settings.transcription.model
      ),
      ...(settings.transcription?.language ? { language: settings.transcription.language } : {}),
      ...(settings.transcription?.prompt ? { prompt: settings.transcription.prompt } : {}),
      ...(settings.transcription?.language ? { languageSource: "stored" } : {}),
      ...(settings.transcription?.prompt ? { promptSource: "stored" } : {}),
    },
    titleGeneration: {
      model: settings.titleGeneration?.model || "openai/gpt-oss-20b",
      modelSource: settings.titleGeneration?.model ? "stored" : "default",
    },
    tts: {
      ...(settings.tts?.engine ? { engine: settings.tts.engine, engineSource: "stored" as const } : {}),
      openaiCompat: {
        ...openaiCompat,
        configured: Boolean(
          settings.tts?.openaiCompat?.baseUrl && settings.tts.openaiCompat.apiKey
        ),
        ...(settings.tts?.openaiCompat?.voice ? { voice: settings.tts.openaiCompat.voice } : {}),
        ...(settings.tts?.openaiCompat?.voice ? { voiceSource: "stored" as const } : {}),
      },
    },
    controller: {
      ...controller,
      configured: Boolean(
        settings.controller?.baseUrl &&
          settings.controller.apiKey &&
          settings.controller.model
      ),
    },
  };
}

export function isVoiceClientTranscriptionConfigured(settings: VoiceClientSettings): boolean {
  return Boolean(
    settings.transcription?.baseUrl &&
      settings.transcription.apiKey &&
      settings.transcription.model
  );
}

export type VoiceCloudSecretRecord = {
  kind: string;
  payload: string;
  updatedAt: number;
};

export function getVoiceSecretsForCloud(): VoiceCloudSecretRecord[] {
  getOrCreateLocalWrappingKey();
  const wrappingKey = readLocalWrappingKey();
  const settings = readStoredRaw();
  const records: VoiceCloudSecretRecord[] = [];
  if (wrappingKey) {
    records.push({
      kind: SECRET_WRAPPING_KEY_CLOUD_KIND,
      payload: wrappingKey,
      updatedAt: settings.updatedAt || Date.now(),
    });
  }
  records.push({
    kind: VOICE_CLIENT_SETTINGS_CLOUD_KIND,
    payload: JSON.stringify(settings),
    updatedAt: settings.updatedAt || Date.now(),
  });
  return records;
}

export function applyCloudVoiceSecrets(records: VoiceCloudSecretRecord[]): void {
  const wrapping = records.find((record) => record.kind === SECRET_WRAPPING_KEY_CLOUD_KIND);
  const settingsRecord = records.find((record) => record.kind === VOICE_CLIENT_SETTINGS_CLOUD_KIND);
  const local = readStoredRaw();
  if (wrapping?.payload && !readLocalWrappingKey()) {
    adoptCloudWrappingKey(wrapping.payload);
  } else if (wrapping?.payload && wrapping.updatedAt >= local.updatedAt) {
    adoptCloudWrappingKey(wrapping.payload);
  }
  if (!settingsRecord?.payload) {
    return;
  }
  if (settingsRecord.updatedAt < local.updatedAt) {
    return;
  }
  try {
    writeStoredRaw(normalizeVoiceClientSettings(JSON.parse(settingsRecord.payload)));
  } catch {
    // Ignore malformed cloud payloads.
  }
}
