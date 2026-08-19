import { resolveTitleGenerationFields, resolveTranscriptionFields } from "./transcription-env.js";
import {
  buildVoiceSpeechSettingsPublic,
  type VoiceSpeechSettingsPublic,
} from "./voice-speech-settings.js";
import { resolveVoiceControllerFields } from "./voice/voice-env.js";
import { resolveOpenAiTtsFields, resolveTtsEnginePreference } from "./voice/tts/settings-resolve.js";

export function resolveVoiceSpeechSettingsPublic(): VoiceSpeechSettingsPublic {
  const transcription = resolveTranscriptionFields();
  const titleGeneration = resolveTitleGenerationFields();
  const controller = resolveVoiceControllerFields();
  const openaiCompat = resolveOpenAiTtsFields();
  const engine = resolveTtsEnginePreference();
  return buildVoiceSpeechSettingsPublic({
    transcription: {
      baseUrl: transcription.baseUrl,
      apiKey: transcription.apiKey,
      model: transcription.model,
      language: transcription.language,
      prompt: transcription.prompt,
    },
    titleGeneration: titleGeneration.titleModel,
    tts: {
      engine,
      openaiCompat,
    },
    controller,
  });
}

export async function getVoiceSpeechSettingsPublic(): Promise<VoiceSpeechSettingsPublic> {
  return resolveVoiceSpeechSettingsPublic();
}
