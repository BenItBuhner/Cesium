import { spawn } from "node:child_process";
import { readWavInfo } from "../wav.js";
import {
  clampSpeed,
  type VoiceTtsEngine,
  type VoiceTtsEngineProbe,
  type VoiceTtsSynthesisRequest,
  type VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * espeak-ng: the always-there formant synthesizer. Robotic, but zero model
 * downloads and zero network - the guaranteed local fallback of the stack.
 */

const CANDIDATE_BINARIES = ["espeak-ng", "espeak"];

let resolvedBinary: string | null | undefined;

async function binaryWorks(bin: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function resolveBinary(): Promise<string | null> {
  if (resolvedBinary !== undefined) return resolvedBinary;
  const configured = process.env.OPENCURSOR_ESPEAK_BIN?.trim();
  const candidates = configured
    ? [configured, ...CANDIDATE_BINARIES]
    : CANDIDATE_BINARIES;
  for (const candidate of candidates) {
    if (await binaryWorks(candidate)) {
      resolvedBinary = candidate;
      return candidate;
    }
  }
  resolvedBinary = null;
  return null;
}

export const espeakEngine: VoiceTtsEngine = {
  id: "espeak",
  label: "eSpeak NG (local, formant)",
  kind: "local",

  async probe(): Promise<VoiceTtsEngineProbe> {
    const bin = await resolveBinary();
    return bin
      ? { available: true, ready: true, detail: bin }
      : {
          available: false,
          ready: false,
          detail: "espeak-ng binary not found on PATH",
        };
  },

  async synthesize(
    request: VoiceTtsSynthesisRequest
  ): Promise<VoiceTtsSynthesisResult> {
    const bin = await resolveBinary();
    if (!bin) {
      throw new Error("espeak-ng is not installed.");
    }
    const startedAt = Date.now();
    const voice = request.voice?.trim() || "en-us";
    const wordsPerMinute = Math.round(175 * clampSpeed(request.speed));
    const audio = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(bin, [
        "-v",
        voice,
        "-s",
        String(wordsPerMinute),
        "--stdout",
        request.text,
      ]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`espeak-ng exited with code ${code}`));
        }
      });
    });
    const info = readWavInfo(audio);
    return {
      audio,
      mimeType: "audio/wav",
      sampleRate: info?.sampleRate ?? null,
      engineId: "espeak",
      voice,
      synthesisMs: Date.now() - startedAt,
    };
  },
};
