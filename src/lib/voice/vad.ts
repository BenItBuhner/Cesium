/**
 * Frame-level voice activity detection behind one interface.
 *
 * - `EnergyVad`: zero-asset default. Adaptive noise floor (fast decay when
 *   quiet, slow rise when loud) turned into a pseudo-probability from the
 *   SNR, so the endpointer thresholds behave consistently across mics.
 * - `SileroVad`: progressive enhancement. Loads the Silero VAD v5 ONNX model
 *   through onnxruntime-web when `/voice/silero_vad_v5.onnx` (plus the ort
 *   wasm files under `/voice/ort/`) are present — see
 *   `scripts/setup-voice-assets.mjs`. Any load failure falls back to
 *   `EnergyVad`; the endpointing state machine is identical either way.
 */

import { rmsLevel } from "./pcm";

export const VAD_FRAME_SAMPLES = 512; // 32 ms @ 16 kHz, Silero v5's native hop

export interface VadEngine {
  readonly id: string;
  /** Returns speech probability (0..1) for one 512-sample 16 kHz frame. */
  process(frame: Float32Array): Promise<number> | number;
  reset(): void;
}

export class EnergyVad implements VadEngine {
  readonly id = "energy";
  private noiseFloor = 0.0015;

  process(frame: Float32Array): number {
    const level = rmsLevel(frame);
    if (level < this.noiseFloor) {
      // Quiet frame: track the floor down quickly.
      this.noiseFloor = this.noiseFloor * 0.9 + level * 0.1;
    } else {
      // Loud frame: let the floor creep up very slowly so sustained speech
      // doesn't get absorbed into "noise".
      this.noiseFloor = this.noiseFloor * 0.999 + level * 0.001;
    }
    this.noiseFloor = Math.max(this.noiseFloor, 0.0005);
    const snr = level / this.noiseFloor;
    // ~3x over the floor => 0.5; saturates near 9x.
    const prob = 1 / (1 + Math.exp(-(snr - 3) * 1.2));
    return Math.max(0, Math.min(1, prob));
  }

  reset(): void {
    this.noiseFloor = 0.0015;
  }
}

type OrtTensor = { data: Float32Array | BigInt64Array };
type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
};
type OrtModule = {
  env: { wasm: { wasmPaths: string; numThreads?: number } };
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: number[]
  ) => unknown;
  InferenceSession: {
    create(
      model: ArrayBuffer,
      options?: Record<string, unknown>
    ): Promise<OrtSession>;
  };
};

export class SileroVad implements VadEngine {
  readonly id = "silero";
  private state: Float32Array;

  constructor(
    private readonly ort: OrtModule,
    private readonly session: OrtSession
  ) {
    this.state = new Float32Array(2 * 1 * 128);
  }

  async process(frame: Float32Array): Promise<number> {
    const input =
      frame.length === VAD_FRAME_SAMPLES
        ? frame
        : padFrame(frame, VAD_FRAME_SAMPLES);
    const feeds = {
      input: new this.ort.Tensor("float32", input, [1, VAD_FRAME_SAMPLES]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(16000)]), []),
    };
    const outputs = await this.session.run(feeds);
    const nextState = outputs.stateN?.data;
    if (nextState instanceof Float32Array) {
      this.state = nextState;
    }
    const prob = outputs.output?.data;
    return prob instanceof Float32Array ? (prob[0] ?? 0) : 0;
  }

  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
  }
}

function padFrame(frame: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size);
  out.set(frame.subarray(0, size));
  return out;
}

export async function createSileroVad(
  assetBase = "/voice"
): Promise<SileroVad | null> {
  try {
    const modelResponse = await fetch(`${assetBase}/silero_vad_v5.onnx`);
    if (!modelResponse.ok) return null;
    const contentType = modelResponse.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) return null; // SPA fallback page
    const model = await modelResponse.arrayBuffer();
    const ort = (await import("onnxruntime-web")) as unknown as OrtModule;
    ort.env.wasm.wasmPaths = `${assetBase}/ort/`;
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
    });
    return new SileroVad(ort, session);
  } catch {
    return null;
  }
}

/** Best available VAD: Silero when its assets are served, else energy. */
export async function createBestVad(assetBase = "/voice"): Promise<VadEngine> {
  const silero = await createSileroVad(assetBase);
  return silero ?? new EnergyVad();
}
