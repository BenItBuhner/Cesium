import { createRequire } from "node:module";
import { encodeWavPcm16 } from "../wav.js";
import {
  clampSpeed,
  type VoiceTtsEngine,
  type VoiceTtsEngineProbe,
  type VoiceTtsSynthesisRequest,
  type VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * Kokoro-82M ONNX (Apache-2.0) through kokoro-js - the blueprint's
 * "best zero-cost/local default". Runs on CPU under Bun; the ~90 MB q8 model
 * is fetched from Hugging Face on first use and cached, so the engine is
 * `available` as soon as the module resolves but only `ready` after the
 * first load.
 */

type KokoroRawAudio = { audio: Float32Array; sampling_rate: number };
type KokoroTtsInstance = {
  generate(
    text: string,
    options?: { voice?: string; speed?: number }
  ): Promise<KokoroRawAudio>;
};

const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";

// kokoro-js is an optionalDependency: its onnxruntime-node transitive dep has
// no Android binaries, so Termux installs run `npm ci --omit=optional` and the
// module is legitimately absent. Keep the specifier out of a literal
// `import("...")` so tsc does not require the package (and its types) to be
// installed at build time; the probe below gates every runtime use.
const KOKORO_MODULE = "kokoro-js";

const require = createRequire(import.meta.url);

let modulePresent: boolean | undefined;
let instancePromise: Promise<KokoroTtsInstance> | null = null;
let instanceReady = false;

function kokoroModulePresent(): boolean {
  if (modulePresent !== undefined) return modulePresent;
  try {
    require.resolve(KOKORO_MODULE);
    modulePresent = true;
  } catch {
    modulePresent = false;
  }
  return modulePresent;
}

async function loadInstance(): Promise<KokoroTtsInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const mod = (await import(KOKORO_MODULE)) as {
        KokoroTTS: {
          from_pretrained(
            modelId: string,
            options: { dtype: string; device: string }
          ): Promise<KokoroTtsInstance>;
        };
      };
      const modelId =
        process.env.OPENCURSOR_KOKORO_MODEL?.trim() || DEFAULT_MODEL_ID;
      const dtype = process.env.OPENCURSOR_KOKORO_DTYPE?.trim() || "q8";
      const instance = await mod.KokoroTTS.from_pretrained(modelId, {
        dtype,
        device: "cpu",
      });
      instanceReady = true;
      return instance;
    })();
    instancePromise.catch(() => {
      // Allow a retry on the next request instead of caching the rejection.
      instancePromise = null;
    });
  }
  return instancePromise;
}

export const kokoroEngine: VoiceTtsEngine = {
  id: "kokoro",
  label: "Kokoro-82M (local, neural)",
  kind: "local",

  async probe(): Promise<VoiceTtsEngineProbe> {
    if (!kokoroModulePresent()) {
      return {
        available: false,
        ready: false,
        detail: "kokoro-js module not installed",
      };
    }
    return {
      available: true,
      ready: instanceReady,
      detail: instanceReady
        ? "model resident"
        : "model loads (and downloads if uncached) on first request",
    };
  },

  async synthesize(
    request: VoiceTtsSynthesisRequest
  ): Promise<VoiceTtsSynthesisResult> {
    const startedAt = Date.now();
    const tts = await loadInstance();
    const voice =
      request.voice?.trim() ||
      process.env.OPENCURSOR_KOKORO_VOICE?.trim() ||
      DEFAULT_VOICE;
    const raw = await tts.generate(request.text, {
      voice,
      speed: clampSpeed(request.speed),
    });
    const audio = encodeWavPcm16(raw.audio, raw.sampling_rate);
    return {
      audio,
      mimeType: "audio/wav",
      sampleRate: raw.sampling_rate,
      engineId: "kokoro",
      voice,
      synthesisMs: Date.now() - startedAt,
    };
  },
};
