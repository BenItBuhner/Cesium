export type VoiceSpeechFieldSource = "stored" | "env" | "file" | "default" | null;

export type VoiceSpeechCredentialPayload = {
  configured: boolean;
  source: VoiceSpeechFieldSource;
  baseUrl?: string;
  model?: string;
  apiKeyLastFour?: string;
  baseUrlSource?: VoiceSpeechFieldSource;
  modelSource?: VoiceSpeechFieldSource;
  apiKeySource?: VoiceSpeechFieldSource;
};

export type VoiceSpeechSettingsPayload = {
  transcription: VoiceSpeechCredentialPayload & {
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
    openaiCompat: VoiceSpeechCredentialPayload & {
      voice?: string;
      voiceSource?: VoiceSpeechFieldSource;
    };
  };
  controller: VoiceSpeechCredentialPayload;
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
