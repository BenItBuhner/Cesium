import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, resolveRepoRootFromProcessCwd } from "./persistence.js";

export type TranscriptionFilePayload = {
  baseUrl: string;
  apiKey: string;
  model: string;
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

export function transcriptionProcessEnv(
  env: NodeJS.ProcessEnv = process.env
): { baseUrl: string; apiKey: string; model: string } {
  const fromEnv = {
    baseUrl: (env.OPENCURSOR_TRANSCRIPTION_BASE_URL ?? env.OPENAI_BASE_URL ?? "").trim(),
    apiKey: (
      env.OPENCURSOR_TRANSCRIPTION_API_KEY ??
      env.OPENAI_API_KEY ??
      env.GROQ_API_KEY ??
      ""
    ).trim(),
    model: (env.OPENCURSOR_TRANSCRIPTION_MODEL ?? "").trim(),
  };
  const fromFile = loadTranscriptionDefaultsPayload();
  return {
    baseUrl: fromEnv.baseUrl || fromFile?.baseUrl || "",
    apiKey: fromEnv.apiKey || fromFile?.apiKey || "",
    model: fromEnv.model || fromFile?.model || "",
  };
}

export function isTranscriptionConfigured(env?: NodeJS.ProcessEnv): boolean {
  const { baseUrl, apiKey, model } = transcriptionProcessEnv(env);
  return Boolean(baseUrl && apiKey && model);
}
