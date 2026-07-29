import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWavInfo } from "../wav.js";
import {
  clampSpeed,
  type VoiceTtsEngine,
  type VoiceTtsEngineProbe,
  type VoiceTtsSynthesisRequest,
  type VoiceTtsSynthesisResult,
} from "./types.js";

/**
 * Piper: fast local neural TTS (ONNX). Discovered from
 * `OPENCURSOR_PIPER_BIN` / `OPENCURSOR_PIPER_VOICE`, or conventional install
 * locations (`~/piper/piper/piper` with a voice .onnx alongside).
 */

type PiperInstall = { binary: string; voice: string };

let resolvedInstall: PiperInstall | null | undefined;

function candidateBinaries(): string[] {
  const home = os.homedir();
  const configured = process.env.OPENCURSOR_PIPER_BIN?.trim();
  const list = [
    ...(configured ? [configured] : []),
    path.join(home, "piper", "piper", "piper"),
    path.join(home, ".local", "share", "piper", "piper"),
    "/usr/local/bin/piper",
    "/usr/bin/piper",
  ];
  return [...new Set(list)];
}

async function findVoiceModel(nearBinary: string): Promise<string | null> {
  const configured = process.env.OPENCURSOR_PIPER_VOICE?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }
  const searchDirs = [
    path.dirname(nearBinary),
    path.dirname(path.dirname(nearBinary)),
  ];
  for (const dir of searchDirs) {
    try {
      const entries = await fs.readdir(dir);
      const onnx = entries.find(
        (entry) => entry.endsWith(".onnx") && !entry.startsWith("libonnx")
      );
      if (onnx) {
        return path.join(dir, onnx);
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveInstall(): Promise<PiperInstall | null> {
  if (resolvedInstall !== undefined) return resolvedInstall;
  for (const binary of candidateBinaries()) {
    if (!existsSync(binary)) continue;
    const voice = await findVoiceModel(binary);
    if (voice) {
      resolvedInstall = { binary, voice };
      return resolvedInstall;
    }
  }
  resolvedInstall = null;
  return null;
}

export const piperEngine: VoiceTtsEngine = {
  id: "piper",
  label: "Piper (local, neural)",
  kind: "local",

  async probe(): Promise<VoiceTtsEngineProbe> {
    const install = await resolveInstall();
    return install
      ? {
          available: true,
          ready: true,
          detail: path.basename(install.voice, ".onnx"),
        }
      : {
          available: false,
          ready: false,
          detail:
            "piper binary + voice .onnx not found (set OPENCURSOR_PIPER_BIN / OPENCURSOR_PIPER_VOICE)",
        };
  },

  async synthesize(
    request: VoiceTtsSynthesisRequest
  ): Promise<VoiceTtsSynthesisResult> {
    const install = await resolveInstall();
    if (!install) {
      throw new Error("Piper is not installed.");
    }
    const voice = request.voice?.trim() || install.voice;
    const startedAt = Date.now();
    const outFile = path.join(
      os.tmpdir(),
      `cesium-voice-piper-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.wav`
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(install.binary, [
          "--model",
          voice,
          "--output_file",
          outFile,
          // Piper's length_scale stretches phoneme durations; invert speed.
          "--length_scale",
          (1 / clampSpeed(request.speed)).toFixed(2),
        ]);
        child.stdin.write(request.text.replace(/\s*\n\s*/g, " "));
        child.stdin.end();
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`piper exited with code ${code}`));
          }
        });
      });
      const audio = await fs.readFile(outFile);
      const info = readWavInfo(audio);
      return {
        audio,
        mimeType: "audio/wav",
        sampleRate: info?.sampleRate ?? null,
        engineId: "piper",
        voice: path.basename(voice, ".onnx"),
        synthesisMs: Date.now() - startedAt,
      };
    } finally {
      void fs.unlink(outFile).catch(() => {});
    }
  },
};
