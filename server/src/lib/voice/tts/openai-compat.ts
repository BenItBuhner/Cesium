import { readWavInfo } from "../wav.js";
import { resolveOpenAiTtsConfig } from "./settings-resolve.js";
import {
  clampSpeed,
  type VoiceTtsEngine,
  type VoiceTtsEngineProbe,
  type VoiceTtsSynthesisRequest,
  type VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * Any OpenAI-compatible `/audio/speech` host (OpenAI itself, LocalAI, a
 * self-hosted Kokoro/Piper server, etc.). Opt-in via Settings → Voice or
 * `OPENCURSOR_VOICE_TTS_BASE_URL`. Chat/transcription base URLs are NOT
 * reused because most proxies (including the techlit one) do not route
 * speech synthesis.
 */

function resolveConfig() {
  return resolveOpenAiTtsConfig();
}

export const openAiCompatEngine: VoiceTtsEngine = {
  id: "openai-compatible",
  label: "OpenAI-compatible /audio/speech (remote)",
  kind: "remote",

  async probe(): Promise<VoiceTtsEngineProbe> {
    const config = resolveConfig();
    return config
      ? { available: true, ready: true, detail: `${config.model} @ ${new URL(config.baseUrl).host}` }
      : {
          available: false,
          ready: false,
          detail: "set a remote TTS base URL in Settings → Voice (or OPENCURSOR_VOICE_TTS_BASE_URL)",
        };
  },

  async synthesize(
    request: VoiceTtsSynthesisRequest
  ): Promise<VoiceTtsSynthesisResult> {
    const config = resolveConfig();
    if (!config) {
      throw new Error("OpenAI-compatible TTS is not configured.");
    }
    const startedAt = Date.now();
    const voice = request.voice?.trim() || config.voice;
    const response = await fetch(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: request.text,
        voice,
        speed: clampSpeed(request.speed),
        response_format: "wav",
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `TTS provider responded ${response.status}: ${text.slice(0, 300)}`
      );
    }
    const audio = Buffer.from(await response.arrayBuffer());
    const info = readWavInfo(audio);
    return {
      audio,
      mimeType: response.headers.get("content-type") ?? "audio/wav",
      sampleRate: info?.sampleRate ?? null,
      engineId: "openai-compatible",
      voice,
      synthesisMs: Date.now() - startedAt,
    };
  },
};
