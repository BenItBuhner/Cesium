import { readWavInfo } from "../wav.js";
import {
  clampSpeed,
  type VoiceTtsEngine,
  type VoiceTtsEngineProbe,
  type VoiceTtsSynthesisRequest,
  type VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * Cartesia Sonic — the blueprint's premium streaming pick. This first slice
 * uses the stateless `/tts/bytes` endpoint behind the shared PCM adapter;
 * the WebSocket context API (incremental clause appends) is the follow-up
 * once clause-level LLM streaming lands. Enabled by `CARTESIA_API_KEY`.
 */

const CARTESIA_VERSION = "2025-04-16";
const DEFAULT_MODEL = "sonic-3";

type CartesiaConfig = { apiKey: string; model: string; voiceId: string | null };

function resolveConfig(): CartesiaConfig | null {
  const apiKey = process.env.CARTESIA_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.CARTESIA_MODEL?.trim() || DEFAULT_MODEL,
    voiceId: process.env.CARTESIA_VOICE_ID?.trim() || null,
  };
}

export const cartesiaEngine: VoiceTtsEngine = {
  id: "cartesia",
  label: "Cartesia Sonic (remote, streaming-capable)",
  kind: "remote",

  async probe(): Promise<VoiceTtsEngineProbe> {
    const config = resolveConfig();
    if (!config) {
      return {
        available: false,
        ready: false,
        detail: "set CARTESIA_API_KEY to enable",
      };
    }
    if (!config.voiceId) {
      return {
        available: false,
        ready: false,
        detail: "set CARTESIA_VOICE_ID to enable",
      };
    }
    return { available: true, ready: true, detail: config.model };
  },

  async synthesize(
    request: VoiceTtsSynthesisRequest
  ): Promise<VoiceTtsSynthesisResult> {
    const config = resolveConfig();
    if (!config?.voiceId) {
      throw new Error("Cartesia TTS is not configured.");
    }
    const startedAt = Date.now();
    const voiceId = request.voice?.trim() || config.voiceId;
    const response = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: config.model,
        transcript: request.text,
        voice: { mode: "id", id: voiceId },
        output_format: {
          container: "wav",
          encoding: "pcm_s16le",
          sample_rate: 24000,
        },
        speed: clampSpeed(request.speed),
        language: "en",
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Cartesia responded ${response.status}: ${text.slice(0, 300)}`
      );
    }
    const audio = Buffer.from(await response.arrayBuffer());
    const info = readWavInfo(audio);
    return {
      audio,
      mimeType: "audio/wav",
      sampleRate: info?.sampleRate ?? 24000,
      engineId: "cartesia",
      voice: voiceId,
      synthesisMs: Date.now() - startedAt,
    };
  },
};
