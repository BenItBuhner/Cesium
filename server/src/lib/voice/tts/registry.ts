import { cartesiaEngine } from "./cartesia.js";
import { espeakEngine } from "./espeak.js";
import { kokoroEngine } from "./kokoro.js";
import { openAiCompatEngine } from "./openai-compat.js";
import { piperEngine } from "./piper.js";
import type {
  VoiceTtsEngine,
  VoiceTtsEngineStatus,
  VoiceTtsSynthesisRequest,
  VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * Engine registry. Preference order favors instant local engines:
 * Piper (fast local neural) -> Kokoro (local neural, first-use model load)
 * -> Cartesia -> OpenAI-compatible -> espeak-ng (always-works fallback).
 *
 * `OPENCURSOR_VOICE_TTS_ENGINE` pins an engine id; `OPENCURSOR_VOICE_TTS_DISABLE`
 * is a comma list of engine ids to skip.
 */

const ENGINES: VoiceTtsEngine[] = [
  piperEngine,
  kokoroEngine,
  cartesiaEngine,
  openAiCompatEngine,
  espeakEngine,
];

const PROBE_TTL_MS = 10_000;

type CachedProbe = { at: number; status: VoiceTtsEngineStatus };
const probeCache = new Map<string, CachedProbe>();

function disabledEngineIds(): Set<string> {
  const raw = process.env.OPENCURSOR_VOICE_TTS_DISABLE ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function probeEngine(engine: VoiceTtsEngine): Promise<VoiceTtsEngineStatus> {
  const cached = probeCache.get(engine.id);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return cached.status;
  }
  let status: VoiceTtsEngineStatus;
  try {
    const probe = await engine.probe();
    status = { id: engine.id, label: engine.label, kind: engine.kind, ...probe };
  } catch (error) {
    status = {
      id: engine.id,
      label: engine.label,
      kind: engine.kind,
      available: false,
      ready: false,
      detail: error instanceof Error ? error.message : "probe failed",
    };
  }
  probeCache.set(engine.id, { at: Date.now(), status });
  return status;
}

export async function listTtsEngineStatuses(): Promise<VoiceTtsEngineStatus[]> {
  const disabled = disabledEngineIds();
  const statuses = await Promise.all(
    ENGINES.map(async (engine) => {
      const status = await probeEngine(engine);
      if (disabled.has(engine.id)) {
        return {
          ...status,
          available: false,
          ready: false,
          detail: "disabled via OPENCURSOR_VOICE_TTS_DISABLE",
        };
      }
      return status;
    })
  );
  return statuses;
}

export async function resolveTtsEngine(
  preferredId?: string | null
): Promise<VoiceTtsEngine | null> {
  const disabled = disabledEngineIds();
  const pinnedId =
    preferredId?.trim().toLowerCase() ||
    process.env.OPENCURSOR_VOICE_TTS_ENGINE?.trim().toLowerCase() ||
    null;
  if (pinnedId) {
    const pinned = ENGINES.find((engine) => engine.id === pinnedId);
    if (pinned && !disabled.has(pinned.id)) {
      const status = await probeEngine(pinned);
      if (status.available) {
        return pinned;
      }
    }
    // An explicitly requested engine that is unavailable falls through to
    // the normal preference order rather than failing the utterance.
  }
  for (const engine of ENGINES) {
    if (disabled.has(engine.id)) continue;
    const status = await probeEngine(engine);
    if (status.available) {
      return engine;
    }
  }
  return null;
}

export async function synthesizeSpeech(
  request: VoiceTtsSynthesisRequest & { engine?: string | null }
): Promise<VoiceTtsSynthesisResult> {
  const engine = await resolveTtsEngine(request.engine);
  if (!engine) {
    throw new Error(
      "No TTS engine is available. Install espeak-ng/piper, add kokoro-js, or configure a remote engine."
    );
  }
  return engine.synthesize(request);
}
