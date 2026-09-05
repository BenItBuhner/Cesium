import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, resolveRepoRootFromProcessCwd } from "./persistence.js";
import {
  getStoredVoiceSpeechSettingsSync,
  resolvePreferredField,
  type VoiceSpeechResolvedField,
} from "./voice-speech-settings.js";

export type TranscriptionFilePayload = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type TranscriptionResolved = {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  prompt: string;
};

export type TranscriptionResolvedFields = {
  baseUrl: VoiceSpeechResolvedField;
  apiKey: VoiceSpeechResolvedField;
  model: VoiceSpeechResolvedField;
  language: VoiceSpeechResolvedField;
  prompt: VoiceSpeechResolvedField;
};

export type TitleGenerationResolvedFields = {
  baseUrl: VoiceSpeechResolvedField;
  apiKey: VoiceSpeechResolvedField;
  titleModel: VoiceSpeechResolvedField;
};

let mergedDefaultsCache: TranscriptionFilePayload | null | undefined;

function parseTranscriptionJson(raw: string): TranscriptionFilePayload | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const baseUrlRaw = j.baseUrl ?? j.baseURL;
    const keyRaw = j.apiKey ?? j.api_key;
    const modelRaw = j.model;
    if (
      typeof baseUrlRaw !== "string" ||
      typeof keyRaw !== "string" ||
      typeof modelRaw !== "string"
    ) {
      return null;
    }
    const baseUrl = baseUrlRaw.trim();
    const apiKey = keyRaw.trim();
    const model = modelRaw.trim();
    if (!baseUrl || !apiKey || !model) return null;
    return { baseUrl, apiKey, model };
  } catch {
    return null;
  }
}

function dataDirResolvedNow(): string {
  const configured = process.env.OPENCURSOR_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return DATA_DIR;
}

function candidateTranscriptionConfigPaths(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.OPENCURSOR_TRANSCRIPTION_CONFIG_FILE?.trim();
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }
  candidates.push(path.join(dataDirResolvedNow(), "profile", "transcription-provider.json"));
  const ws = process.env.WORKSPACE_ROOT?.trim();
  if (ws) {
    candidates.push(path.join(path.resolve(ws), "server", "transcription-provider.json"));
  }
  const repo = resolveRepoRootFromProcessCwd();
  candidates.push(path.join(repo, "server", "transcription-provider.json"));
  candidates.push(path.join(repo, "transcription-provider.json"));
  return [...new Set(candidates)];
}

function loadTranscriptionDefaultsPayload(): TranscriptionFilePayload | null {
  if (mergedDefaultsCache !== undefined) {
    return mergedDefaultsCache;
  }
  const inline = process.env.OPENCURSOR_TRANSCRIPTION_CONFIG_JSON?.trim();
  if (inline) {
    const parsed = parseTranscriptionJson(inline);
    if (parsed) {
      mergedDefaultsCache = parsed;
      return parsed;
    }
  }
  for (const configPath of candidateTranscriptionConfigPaths()) {
    try {
      if (!existsSync(configPath)) {
        continue;
      }
      const parsed = parseTranscriptionJson(readFileSync(configPath, "utf8"));
      if (parsed) {
        mergedDefaultsCache = parsed;
        return parsed;
      }
    } catch {
      continue;
    }
  }
  mergedDefaultsCache = null;
  return null;
}

function useStoredSettings(env: NodeJS.ProcessEnv): boolean {
  return env === process.env;
}

export function resolveTranscriptionFields(
  env: NodeJS.ProcessEnv = process.env
): TranscriptionResolvedFields {
  const stored = useStoredSettings(env)
    ? getStoredVoiceSpeechSettingsSync()?.transcription
    : undefined;
  const fromFile = loadTranscriptionDefaultsPayload();
  return {
    baseUrl: resolvePreferredField(
      stored?.baseUrl,
      env.OPENCURSOR_TRANSCRIPTION_BASE_URL ?? env.OPENAI_BASE_URL,
      fromFile?.baseUrl
    ),
    apiKey: resolvePreferredField(
      stored?.apiKey,
      env.OPENCURSOR_TRANSCRIPTION_API_KEY ?? env.OPENAI_API_KEY ?? env.GROQ_API_KEY,
      fromFile?.apiKey
    ),
    model: resolvePreferredField(
      stored?.model,
      env.OPENCURSOR_TRANSCRIPTION_MODEL,
      fromFile?.model
    ),
    language: resolvePreferredField(
      stored?.language,
      env.OPENCURSOR_TRANSCRIPTION_LANGUAGE
    ),
    prompt: resolvePreferredField(
      stored?.prompt,
      env.OPENCURSOR_TRANSCRIPTION_PROMPT
    ),
  };
}

export function transcriptionProcessEnv(
  env: NodeJS.ProcessEnv = process.env
): TranscriptionResolved {
  const fields = resolveTranscriptionFields(env);
  return {
    baseUrl: fields.baseUrl.value ?? "",
    apiKey: fields.apiKey.value ?? "",
    model: fields.model.value ?? "",
    language: fields.language.value ?? "",
    prompt: fields.prompt.value ?? "",
  };
}

export function isTranscriptionConfigured(env?: NodeJS.ProcessEnv): boolean {
  const { baseUrl, apiKey, model } = transcriptionProcessEnv(env);
  return Boolean(baseUrl && apiKey && model);
}

export function resolveTitleGenerationFields(
  env: NodeJS.ProcessEnv = process.env
): TitleGenerationResolvedFields {
  const transcription = resolveTranscriptionFields(env);
  const stored = useStoredSettings(env)
    ? getStoredVoiceSpeechSettingsSync()?.titleGeneration
    : undefined;
  const envTitle = env.OPENCURSOR_TITLE_MODEL?.trim();
  const titleModel = resolvePreferredField(stored?.model, envTitle);
  return {
    baseUrl: transcription.baseUrl,
    apiKey: transcription.apiKey,
    titleModel: titleModel.value
      ? titleModel
      : { value: "openai/gpt-oss-20b", source: "default" },
  };
}

export function titleGenerationProcessEnv(
  env: NodeJS.ProcessEnv = process.env
): { baseUrl: string; apiKey: string; titleModel: string } {
  const fields = resolveTitleGenerationFields(env);
  return {
    baseUrl: fields.baseUrl.value ?? "",
    apiKey: fields.apiKey.value ?? "",
    titleModel: fields.titleModel.value ?? "openai/gpt-oss-20b",
  };
}
