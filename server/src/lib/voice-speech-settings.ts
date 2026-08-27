import path from "node:path";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import { isSecretEnvelope, secretLastFour } from "@cesium/core";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";
import { openSecretSync, sealSecretSync } from "./secret-envelope-node.js";
import { getSecretWrappingKeySync } from "./secret-wrapping-key.js";

/**
 * User-facing voice / speech settings that used to live only in env vars
 * (`OPENCURSOR_TRANSCRIPTION_*`, `OPENCURSOR_TITLE_MODEL`,
 * `OPENCURSOR_VOICE_*`, `OPENCURSOR_VOICE_TTS_*`).
 *
 * Stored values win field-by-field; env (and the transcription JSON file)
 * remain the fallback so headless / cloud-agent deployments keep working.
 */

export type VoiceSpeechFieldSource = "stored" | "env" | "file" | "default" | null;

export type VoiceSpeechTranscriptionStored = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  prompt?: string;
};

export type VoiceSpeechTitleStored = {
  model?: string;
};

export type VoiceSpeechTtsStored = {
  engine?: string;
  openaiCompat?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    voice?: string;
  };
};

export type VoiceSpeechControllerStored = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type VoiceSpeechSettings = {
  schemaVersion: 1;
  updatedAt: number;
  transcription?: VoiceSpeechTranscriptionStored;
  titleGeneration?: VoiceSpeechTitleStored;
  tts?: VoiceSpeechTtsStored;
  controller?: VoiceSpeechControllerStored;
};

export type VoiceSpeechSettingsPatch = {
  transcription?: {
    baseUrl?: string | null;
    apiKey?: string | null;
    model?: string | null;
    language?: string | null;
    prompt?: string | null;
  };
  titleGeneration?: {
    model?: string | null;
  };
  tts?: {
    engine?: string | null;
    openaiCompat?: {
      baseUrl?: string | null;
      apiKey?: string | null;
      model?: string | null;
      voice?: string | null;
    } | null;
  };
  controller?: {
    baseUrl?: string | null;
    apiKey?: string | null;
    model?: string | null;
  };
};

export type VoiceSpeechResolvedField = {
  value?: string;
  source: VoiceSpeechFieldSource;
};

export type VoiceSpeechCredentialPublic = {
  configured: boolean;
  source: VoiceSpeechFieldSource;
  baseUrl?: string;
  model?: string;
  apiKeyLastFour?: string;
  baseUrlSource?: VoiceSpeechFieldSource;
  modelSource?: VoiceSpeechFieldSource;
  apiKeySource?: VoiceSpeechFieldSource;
};

export type VoiceSpeechSettingsPublic = {
  transcription: VoiceSpeechCredentialPublic & {
    language?: string;
    prompt?: string;
    languageSource?: VoiceSpeechFieldSource;
    promptSource?: VoiceSpeechFieldSource;
  };
  titleGeneration: {
    model: string;
    modelSource: VoiceSpeechFieldSource;
  };
  tts: {
    engine?: string;
    engineSource?: VoiceSpeechFieldSource;
    openaiCompat: VoiceSpeechCredentialPublic & {
      voice?: string;
      voiceSource?: VoiceSpeechFieldSource;
    };
  };
  controller: VoiceSpeechCredentialPublic;
};

const SETTINGS_FILE = path.join(DATA_DIR, "profile", "voice-speech-settings.json");

let syncCache: VoiceSpeechSettings | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const API_KEY_PURPOSES = {
  transcription: "voice.transcription.apiKey",
  tts: "voice.tts.apiKey",
  controller: "voice.controller.apiKey",
} as const;

function sealApiKey(value: string | undefined, purpose: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isSecretEnvelope(trimmed)) {
    return trimmed;
  }
  return sealSecretSync(trimmed, getSecretWrappingKeySync(), purpose);
}

function openApiKey(value: string | undefined, purpose: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isSecretEnvelope(trimmed)) {
    return trimmed;
  }
  return openSecretSync(trimmed, getSecretWrappingKeySync(), purpose) ?? undefined;
}

function sealStoredSettings(settings: VoiceSpeechSettings): VoiceSpeechSettings {
  return {
    ...settings,
    ...(settings.transcription
      ? {
          transcription: {
            ...settings.transcription,
            ...(settings.transcription.apiKey
              ? { apiKey: sealApiKey(settings.transcription.apiKey, API_KEY_PURPOSES.transcription) }
              : {}),
          },
        }
      : {}),
    ...(settings.tts?.openaiCompat
      ? {
          tts: {
            ...settings.tts,
            openaiCompat: {
              ...settings.tts.openaiCompat,
              ...(settings.tts.openaiCompat.apiKey
                ? { apiKey: sealApiKey(settings.tts.openaiCompat.apiKey, API_KEY_PURPOSES.tts) }
                : {}),
            },
          },
        }
      : settings.tts
        ? { tts: settings.tts }
        : {}),
    ...(settings.controller
      ? {
          controller: {
            ...settings.controller,
            ...(settings.controller.apiKey
              ? { apiKey: sealApiKey(settings.controller.apiKey, API_KEY_PURPOSES.controller) }
              : {}),
          },
        }
      : {}),
  };
}

function openStoredSettings(settings: VoiceSpeechSettings): VoiceSpeechSettings {
  return {
    ...settings,
    ...(settings.transcription
      ? {
          transcription: {
            ...settings.transcription,
            ...(settings.transcription.apiKey
              ? { apiKey: openApiKey(settings.transcription.apiKey, API_KEY_PURPOSES.transcription) }
              : {}),
          },
        }
      : {}),
    ...(settings.tts?.openaiCompat
      ? {
          tts: {
            ...settings.tts,
            openaiCompat: {
              ...settings.tts.openaiCompat,
              ...(settings.tts.openaiCompat.apiKey
                ? { apiKey: openApiKey(settings.tts.openaiCompat.apiKey, API_KEY_PURPOSES.tts) }
                : {}),
            },
          },
        }
      : settings.tts
        ? { tts: settings.tts }
        : {}),
    ...(settings.controller
      ? {
          controller: {
            ...settings.controller,
            ...(settings.controller.apiKey
              ? { apiKey: openApiKey(settings.controller.apiKey, API_KEY_PURPOSES.controller) }
              : {}),
          },
        }
      : {}),
  };
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

function normalizeTranscription(raw: unknown): VoiceSpeechTranscriptionStored | undefined {
  const picked = pickOptionalStrings(asRecord(raw), [
    "baseUrl",
    "apiKey",
    "model",
    "language",
    "prompt",
  ] as const);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function normalizeTitle(raw: unknown): VoiceSpeechTitleStored | undefined {
  const picked = pickOptionalStrings(asRecord(raw), ["model"] as const);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function normalizeTts(raw: unknown): VoiceSpeechTtsStored | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const engine = asOptionalString(record.engine);
  const openaiCompat = pickOptionalStrings(asRecord(record.openaiCompat), [
    "baseUrl",
    "apiKey",
    "model",
    "voice",
  ] as const);
  const next: VoiceSpeechTtsStored = {};
  if (engine) {
    next.engine = engine;
  }
  if (Object.keys(openaiCompat).length > 0) {
    next.openaiCompat = openaiCompat;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeController(raw: unknown): VoiceSpeechControllerStored | undefined {
  const picked = pickOptionalStrings(asRecord(raw), ["baseUrl", "apiKey", "model"] as const);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function normalizeSettings(raw: unknown): VoiceSpeechSettings | null {
  const record = asRecord(raw);
  if (!record || record.schemaVersion !== 1) {
    return null;
  }
  const transcription = normalizeTranscription(record.transcription);
  const titleGeneration = normalizeTitle(record.titleGeneration);
  const tts = normalizeTts(record.tts);
  const controller = normalizeController(record.controller);
  if (!transcription && !titleGeneration && !tts && !controller) {
    return null;
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0,
    ...(transcription ? { transcription } : {}),
    ...(titleGeneration ? { titleGeneration } : {}),
    ...(tts ? { tts } : {}),
    ...(controller ? { controller } : {}),
  };
}

function setSyncCache(settings: VoiceSpeechSettings | null): void {
  syncCache = settings;
}

export function invalidateVoiceSpeechSettingsCache(): void {
  syncCache = undefined;
}

function hydrateStored(raw: unknown): VoiceSpeechSettings | null {
  const settings = normalizeSettings(raw);
  return settings ? openStoredSettings(settings) : null;
}

function readStoredSync(): VoiceSpeechSettings | null {
  if (syncCache !== undefined) {
    return syncCache;
  }
  try {
    const settings = hydrateStored(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")));
    syncCache = settings;
    return settings;
  } catch {
    syncCache = null;
    return null;
  }
}

export function getStoredVoiceSpeechSettingsSync(): VoiceSpeechSettings | null {
  return readStoredSync();
}

async function readStored(): Promise<VoiceSpeechSettings | null> {
  const stored = hydrateStored(await readJsonFile<unknown>(SETTINGS_FILE, null));
  setSyncCache(stored);
  return stored;
}

export async function getVoiceSpeechSettings(): Promise<VoiceSpeechSettings | null> {
  return readStored();
}

export function resolvePreferredField(
  storedValue: string | undefined,
  envValue: string | undefined,
  fileValue?: string | undefined
): VoiceSpeechResolvedField {
  if (storedValue?.trim()) {
    return { value: storedValue.trim(), source: "stored" };
  }
  if (envValue?.trim()) {
    return { value: envValue.trim(), source: "env" };
  }
  if (fileValue?.trim()) {
    return { value: fileValue.trim(), source: "file" };
  }
  return { source: null };
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

function mergePatch(
  current: VoiceSpeechSettings | null,
  patch: VoiceSpeechSettingsPatch
): VoiceSpeechSettings {
  const next: VoiceSpeechSettings = {
    schemaVersion: 1,
    updatedAt: Date.now(),
    ...(current?.transcription ? { transcription: { ...current.transcription } } : {}),
    ...(current?.titleGeneration ? { titleGeneration: { ...current.titleGeneration } } : {}),
    ...(current?.tts
      ? {
          tts: {
            ...(current.tts.engine ? { engine: current.tts.engine } : {}),
            ...(current.tts.openaiCompat ? { openaiCompat: { ...current.tts.openaiCompat } } : {}),
          },
        }
      : {}),
    ...(current?.controller ? { controller: { ...current.controller } } : {}),
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
    const tts: VoiceSpeechTtsStored = { ...(next.tts ?? {}) };
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

function hasPersistedValues(settings: VoiceSpeechSettings): boolean {
  return Boolean(
    settings.transcription ||
      settings.titleGeneration ||
      settings.tts ||
      settings.controller
  );
}

function credentialPublic(input: {
  baseUrl: VoiceSpeechResolvedField;
  apiKey: VoiceSpeechResolvedField;
  model: VoiceSpeechResolvedField;
}): VoiceSpeechCredentialPublic {
  const sources = [input.baseUrl.source, input.apiKey.source, input.model.source].filter(
    (source): source is Exclude<VoiceSpeechFieldSource, null> => Boolean(source)
  );
  const source: VoiceSpeechFieldSource =
    sources.find((item) => item === "stored") ??
    sources.find((item) => item === "env") ??
    sources.find((item) => item === "file") ??
    null;
  return {
    configured: Boolean(input.baseUrl.value && input.apiKey.value && input.model.value),
    source,
    ...(input.baseUrl.value ? { baseUrl: input.baseUrl.value } : {}),
    ...(input.model.value ? { model: input.model.value } : {}),
    ...(input.apiKey.value ? { apiKeyLastFour: secretLastFour(input.apiKey.value) } : {}),
    ...(input.baseUrl.source ? { baseUrlSource: input.baseUrl.source } : {}),
    ...(input.model.source ? { modelSource: input.model.source } : {}),
    ...(input.apiKey.source ? { apiKeySource: input.apiKey.source } : {}),
  };
}

export function buildVoiceSpeechSettingsPublic(
  resolved: {
    transcription: {
      baseUrl: VoiceSpeechResolvedField;
      apiKey: VoiceSpeechResolvedField;
      model: VoiceSpeechResolvedField;
      language: VoiceSpeechResolvedField;
      prompt: VoiceSpeechResolvedField;
    };
    titleGeneration: VoiceSpeechResolvedField;
    tts: {
      engine: VoiceSpeechResolvedField;
      openaiCompat: {
        baseUrl: VoiceSpeechResolvedField;
        apiKey: VoiceSpeechResolvedField;
        model: VoiceSpeechResolvedField;
        voice: VoiceSpeechResolvedField;
      };
    };
    controller: {
      baseUrl: VoiceSpeechResolvedField;
      apiKey: VoiceSpeechResolvedField;
      model: VoiceSpeechResolvedField;
    };
  }
): VoiceSpeechSettingsPublic {
  const transcription = credentialPublic(resolved.transcription);
  const openaiCompat = credentialPublic(resolved.tts.openaiCompat);
  const controller = credentialPublic(resolved.controller);
  return {
    transcription: {
      ...transcription,
      configured: Boolean(
        resolved.transcription.baseUrl.value &&
          resolved.transcription.apiKey.value &&
          resolved.transcription.model.value
      ),
      ...(resolved.transcription.language.value
        ? { language: resolved.transcription.language.value }
        : {}),
      ...(resolved.transcription.prompt.value
        ? { prompt: resolved.transcription.prompt.value }
        : {}),
      ...(resolved.transcription.language.source
        ? { languageSource: resolved.transcription.language.source }
        : {}),
      ...(resolved.transcription.prompt.source
        ? { promptSource: resolved.transcription.prompt.source }
        : {}),
    },
    titleGeneration: {
      model: resolved.titleGeneration.value || "openai/gpt-oss-20b",
      modelSource: resolved.titleGeneration.source ?? "default",
    },
    tts: {
      ...(resolved.tts.engine.value ? { engine: resolved.tts.engine.value } : {}),
      ...(resolved.tts.engine.source ? { engineSource: resolved.tts.engine.source } : {}),
      openaiCompat: {
        ...openaiCompat,
        configured: Boolean(
          resolved.tts.openaiCompat.baseUrl.value && resolved.tts.openaiCompat.apiKey.value
        ),
        ...(resolved.tts.openaiCompat.voice.value
          ? { voice: resolved.tts.openaiCompat.voice.value }
          : {}),
        ...(resolved.tts.openaiCompat.voice.source
          ? { voiceSource: resolved.tts.openaiCompat.voice.source }
          : {}),
      },
    },
    controller: {
      ...controller,
      configured: Boolean(
        resolved.controller.baseUrl.value &&
          resolved.controller.apiKey.value &&
          resolved.controller.model.value
      ),
    },
  };
}

export async function saveVoiceSpeechSettings(
  input: VoiceSpeechSettingsPatch
): Promise<VoiceSpeechSettings> {
  const current = await readStored();
  const next = mergePatch(current, input);
  if (!hasPersistedValues(next)) {
    await deleteVoiceSpeechSettings();
    return { schemaVersion: 1, updatedAt: Date.now() };
  }
  await writeJsonFile(SETTINGS_FILE, sealStoredSettings(next));
  setSyncCache(next);
  return next;
}

export async function patchVoiceSpeechSettings(
  input: VoiceSpeechSettingsPatch
): Promise<VoiceSpeechSettings> {
  return saveVoiceSpeechSettings(input);
}

export async function deleteVoiceSpeechSettings(): Promise<void> {
  await fs.unlink(SETTINGS_FILE).catch((error: unknown) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw error;
    }
  });
  setSyncCache(null);
}

