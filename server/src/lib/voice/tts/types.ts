/**
 * PCM-oriented TTS adapter contract. Every engine — local (Kokoro, Piper,
 * espeak-ng) or remote (Cartesia, OpenAI-compatible /audio/speech) — resolves
 * to the same interface and returns a mono PCM16 WAV buffer, so playback,
 * barge-in, and clause streaming on the client are engine-agnostic.
 */

export type VoiceTtsSynthesisRequest = {
  text: string;
  /** Engine-specific voice id (e.g. "af_heart", a Piper .onnx path, "alloy"). */
  voice?: string;
  /** Speech rate multiplier; 1 = default. Engines clamp to a sane range. */
  speed?: number;
};

export type VoiceTtsSynthesisResult = {
  audio: Buffer;
  mimeType: string;
  sampleRate: number | null;
  engineId: string;
  voice: string | null;
  synthesisMs: number;
};

export type VoiceTtsEngineProbe = {
  available: boolean;
  /**
   * `ready` means the next synthesis call is expected to be fast (binary on
   * disk / model already resident). Kokoro is `available` once the module
   * resolves but only `ready` after its first model load.
   */
  ready: boolean;
  detail?: string;
};

export type VoiceTtsEngineStatus = VoiceTtsEngineProbe & {
  id: string;
  label: string;
  kind: "local" | "remote";
};

export interface VoiceTtsEngine {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  probe(): Promise<VoiceTtsEngineProbe>;
  synthesize(request: VoiceTtsSynthesisRequest): Promise<VoiceTtsSynthesisResult>;
}

export function clampSpeed(speed: number | undefined): number {
  if (!Number.isFinite(speed) || speed === undefined) return 1;
  return Math.max(0.5, Math.min(2, speed));
}
