import {
  getStoredVoiceSpeechSettingsSync,
  resolvePreferredField,
  type VoiceSpeechResolvedField,
} from "../../voice-speech-settings.js";

export type OpenAiTtsResolvedFields = {
  baseUrl: VoiceSpeechResolvedField;
  apiKey: VoiceSpeechResolvedField;
  model: VoiceSpeechResolvedField;
  voice: VoiceSpeechResolvedField;
};

export type OpenAiTtsConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
};

export function resolveOpenAiTtsFields(
  env: NodeJS.ProcessEnv = process.env
): OpenAiTtsResolvedFields {
  const stored =
    env === process.env
      ? getStoredVoiceSpeechSettingsSync()?.tts?.openaiCompat
      : undefined;
  const model = resolvePreferredField(stored?.model, env.OPENCURSOR_VOICE_TTS_MODEL);
  const voice = resolvePreferredField(stored?.voice, env.OPENCURSOR_VOICE_TTS_VOICE);
  return {
    baseUrl: resolvePreferredField(stored?.baseUrl, env.OPENCURSOR_VOICE_TTS_BASE_URL),
    apiKey: resolvePreferredField(
      stored?.apiKey,
      env.OPENCURSOR_VOICE_TTS_API_KEY ?? env.OPENAI_API_KEY
    ),
    model: model.value ? model : { value: "tts-1", source: "default" },
    voice: voice.value ? voice : { value: "alloy", source: "default" },
  };
}

export function resolveOpenAiTtsConfig(
  env: NodeJS.ProcessEnv = process.env
): OpenAiTtsConfig | null {
  const fields = resolveOpenAiTtsFields(env);
  if (!fields.baseUrl.value || !fields.apiKey.value) {
    return null;
  }
  return {
    baseUrl: fields.baseUrl.value.replace(/\/+$/, ""),
    apiKey: fields.apiKey.value,
    model: fields.model.value || "tts-1",
    voice: fields.voice.value || "alloy",
  };
}

export function resolveTtsEnginePreference(
  env: NodeJS.ProcessEnv = process.env
): VoiceSpeechResolvedField {
  const stored =
    env === process.env ? getStoredVoiceSpeechSettingsSync()?.tts?.engine : undefined;
  return resolvePreferredField(stored, env.OPENCURSOR_VOICE_TTS_ENGINE);
}
