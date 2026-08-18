/**
 * Voice control-plane resolution.
 *
 * Settings → Voice wins field-by-field over env. Env remains the fallback
 * so headless / cloud-agent deployments keep working:
 *
 * - stored controller.baseUrl -> `OPENCURSOR_VOICE_BASE_URL` -> `CESIUM_BASE_URL` -> `OPENAI_BASE_URL`
 * - stored controller.apiKey  -> `OPENCURSOR_VOICE_API_KEY`  -> `CESIUM_API_KEY`  -> `OPENAI_API_KEY`
 * - stored controller.model   -> `OPENCURSOR_VOICE_MODEL`    -> `CESIUM_DEFAULT_MODEL` -> "glm-5.2"
 */

import {
  getStoredVoiceSpeechSettingsSync,
  resolvePreferredField,
  type VoiceSpeechResolvedField,
} from "../voice-speech-settings.js";

export type VoiceControllerEnv = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type VoiceControllerResolvedFields = {
  baseUrl: VoiceSpeechResolvedField;
  apiKey: VoiceSpeechResolvedField;
  model: VoiceSpeechResolvedField;
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function useStoredSettings(env: NodeJS.ProcessEnv): boolean {
  return env === process.env;
}

export function resolveVoiceControllerFields(
  env: NodeJS.ProcessEnv = process.env
): VoiceControllerResolvedFields {
  const stored = useStoredSettings(env)
    ? getStoredVoiceSpeechSettingsSync()?.controller
    : undefined;
  const baseUrl = resolvePreferredField(
    stored?.baseUrl,
    env.OPENCURSOR_VOICE_BASE_URL ?? env.CESIUM_BASE_URL ?? env.OPENAI_BASE_URL
  );
  const apiKey = resolvePreferredField(
    stored?.apiKey,
    env.OPENCURSOR_VOICE_API_KEY ?? env.CESIUM_API_KEY ?? env.OPENAI_API_KEY
  );
  const model = resolvePreferredField(
    stored?.model,
    env.OPENCURSOR_VOICE_MODEL ?? env.CESIUM_DEFAULT_MODEL
  );
  return {
    baseUrl: baseUrl.value
      ? { value: normalizeBaseUrl(baseUrl.value), source: baseUrl.source }
      : baseUrl,
    apiKey,
    model: model.value ? model : { value: "glm-5.2", source: "default" },
  };
}

export function voiceControllerEnv(
  env: NodeJS.ProcessEnv = process.env
): VoiceControllerEnv {
  const fields = resolveVoiceControllerFields(env);
  return {
    baseUrl: fields.baseUrl.value ?? "",
    apiKey: fields.apiKey.value ?? "",
    model: fields.model.value ?? "glm-5.2",
  };
}

export function isVoiceControllerConfigured(env?: NodeJS.ProcessEnv): boolean {
  const { baseUrl, apiKey, model } = voiceControllerEnv(env);
  return Boolean(baseUrl && apiKey && model);
}

/**
 * Optional JSON merged into every controller chat/completions body. Lets a
 * deployment disable provider-specific reasoning or set sampling knobs
 * without code changes, e.g. `{"temperature":0.2}`.
 */
export function voiceControllerExtraBody(
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const raw = env.OPENCURSOR_VOICE_EXTRA_BODY?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed overrides; the base request body still works.
  }
  return {};
}
