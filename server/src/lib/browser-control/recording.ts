import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  startDebugSessionScreencast,
  stopDebugSessionScreencast,
} from "../../browser-debug/chromium-session.js";
import {
  saveBrowserVideoArtifact,
  type BrowserArtifactRecord,
} from "./artifacts.js";

export type BrowserRecordingStatus = {
  tabId: string;
  recording: boolean;
  startedAt: number | null;
  frameCount: number;
  durationMs: number;
};

export type BrowserRecordingResult = {
  artifact: BrowserArtifactRecord;
  frameCount: number;
  durationMs: number;
  encoder: "ffmpeg";
};

type ActiveRecording = {
  tabId: string;
  workspaceId: string;
  debugSessionId: string;
  frameDir: string;
  startedAt: number;
  frameTimestamps: number[];
  writeQueue: Promise<void>;
  stopped: boolean;
};

const activeRecordings = new Map<string, ActiveRecording>();
const MAX_RECORDING_FRAMES = 20 * 60 * 10; // ~20 minutes at 10fps
const MIN_LAST_FRAME_DURATION_S = 0.35;

let cachedFfmpegPath: string | null | undefined;

async function commandWorks(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const child = spawn(command, ["-version"], { stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Locate an ffmpeg binary: explicit env override, system PATH, then the
 * Playwright browser cache (Playwright ships its own ffmpeg build).
 */
export async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }
  const candidates: string[] = [];
  const envPath = process.env.OPENCURSOR_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim();
  if (envPath) candidates.push(envPath);
  candidates.push("ffmpeg");
  try {
    const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
    for (const entry of await fs.readdir(cacheDir)) {
      if (!entry.startsWith("ffmpeg")) continue;
      const dir = path.join(cacheDir, entry);
      for (const file of await fs.readdir(dir)) {
        if (file.startsWith("ffmpeg")) {
          candidates.push(path.join(dir, file));
        }
      }
    }
  } catch {
    // no playwright cache
  }
  for (const candidate of candidates) {
    if (await commandWorks(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }
  cachedFfmpegPath = null;
  return null;
}

export function resetFfmpegPathCacheForTests(): void {
  cachedFfmpegPath = undefined;
}

function frameFileName(index: number): string {
  return `frame-${String(index).padStart(6, "0")}.png`;
}

export function isBrowserRecordingActive(tabId: string): boolean {
  return activeRecordings.has(tabId);
}

export function browserRecordingStatus(tabId: string): BrowserRecordingStatus {
  const active = activeRecordings.get(tabId);
  if (!active) {
    return { tabId, recording: false, startedAt: null, frameCount: 0, durationMs: 0 };
  }
  return {
    tabId,
    recording: true,
    startedAt: active.startedAt,
    frameCount: active.frameTimestamps.length,
    durationMs: Date.now() - active.startedAt,
  };
}

export async function startBrowserRecording(input: {
  workspaceId: string;
  tabId: string;
  debugSessionId: string;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}): Promise<BrowserRecordingStatus> {
  if (activeRecordings.has(input.tabId)) {
    throw new Error(
      "A demo recording is already running for this tab. Call browser_record with action=stop first."
    );
  }
  const frameDir = await mkdtemp(path.join(os.tmpdir(), "cesium-recording-"));
  const recording: ActiveRecording = {
    tabId: input.tabId,
    workspaceId: input.workspaceId,
    debugSessionId: input.debugSessionId,
    frameDir,
    startedAt: Date.now(),
    frameTimestamps: [],
    writeQueue: Promise.resolve(),
    stopped: false,
  };
  activeRecordings.set(input.tabId, recording);
  try {
    await startDebugSessionScreencast(
      input.debugSessionId,
      {
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        everyNthFrame: input.everyNthFrame,
      },
      (frame) => {
        if (recording.stopped) return;
        if (recording.frameTimestamps.length >= MAX_RECORDING_FRAMES) return;
        const index = recording.frameTimestamps.length + 1;
        recording.frameTimestamps.push(frame.ts);
        const filePath = path.join(frameDir, frameFileName(index));
        recording.writeQueue = recording.writeQueue
          .then(() => fs.writeFile(filePath, Buffer.from(frame.data, "base64")))
          .catch(() => undefined);
      }
    );
  } catch (error) {
    activeRecordings.delete(input.tabId);
    await rm(frameDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return browserRecordingStatus(input.tabId);
}

export async function discardBrowserRecording(tabId: string): Promise<void> {
  const recording = activeRecordings.get(tabId);
  if (!recording) return;
  recording.stopped = true;
  activeRecordings.delete(tabId);
  await stopDebugSessionScreencast(recording.debugSessionId).catch(() => undefined);
  await recording.writeQueue.catch(() => undefined);
  await rm(recording.frameDir, { recursive: true, force: true }).catch(() => undefined);
}

function buildConcatList(recording: ActiveRecording): string {
  const lines: string[] = [];
  const timestamps = recording.frameTimestamps;
  for (let index = 0; index < timestamps.length; index += 1) {
    const current = timestamps[index]!;
    const next = timestamps[index + 1];
    const durationS = next != null
      ? Math.max(0.02, (next - current) / 1000)
      : Math.max(MIN_LAST_FRAME_DURATION_S, 0.02);
    lines.push(`file '${frameFileName(index + 1)}'`);
    lines.push(`duration ${durationS.toFixed(3)}`);
  }
  // Concat demuxer needs the final frame repeated so the last duration applies.
  lines.push(`file '${frameFileName(timestamps.length)}'`);
  return `${lines.join("\n")}\n`;
}

async function runFfmpeg(ffmpegPath: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function encodeRecording(
  ffmpegPath: string,
  recording: ActiveRecording
): Promise<{ outputPath: string; mimeType: string; extension: string }> {
  const listPath = path.join(recording.frameDir, "frames.txt");
  await fs.writeFile(listPath, buildConcatList(recording), "utf8");
  const sharedArgs = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-vsync",
    "vfr",
  ];
  const mp4Path = path.join(recording.frameDir, "recording.mp4");
  try {
    await runFfmpeg(
      ffmpegPath,
      [...sharedArgs, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", mp4Path],
      recording.frameDir
    );
    return { outputPath: mp4Path, mimeType: "video/mp4", extension: "mp4" };
  } catch {
    // ffmpeg builds without libx264 (e.g. Playwright's) still ship VP8.
    const webmPath = path.join(recording.frameDir, "recording.webm");
    await runFfmpeg(
      ffmpegPath,
      [...sharedArgs, "-c:v", "vp8", "-b:v", "2M", webmPath],
      recording.frameDir
    );
    return { outputPath: webmPath, mimeType: "video/webm", extension: "webm" };
  }
}

export async function stopBrowserRecording(input: {
  tabId: string;
  workspaceRoot: string;
  fileName?: string;
}): Promise<BrowserRecordingResult> {
  const recording = activeRecordings.get(input.tabId);
  if (!recording) {
    throw new Error("No demo recording is running for this tab. Call browser_record with action=start first.");
  }
  recording.stopped = true;
  activeRecordings.delete(input.tabId);
  const endedAt = Date.now();
  try {
    await stopDebugSessionScreencast(recording.debugSessionId).catch(() => undefined);
    await recording.writeQueue.catch(() => undefined);
    if (recording.frameTimestamps.length === 0) {
      throw new Error(
        "The recording captured zero frames. The page likely never painted while recording — navigate or interact with the tab between start and stop."
      );
    }
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "No ffmpeg binary found to encode the demo video. Install ffmpeg (e.g. apt install ffmpeg) or set OPENCURSOR_FFMPEG_PATH."
      );
    }
    const encoded = await encodeRecording(ffmpegPath, recording);
    const artifact = await saveBrowserVideoArtifact({
      workspaceRoot: input.workspaceRoot,
      sourcePath: encoded.outputPath,
      fileName: input.fileName,
      mimeType: encoded.mimeType,
      extension: encoded.extension,
    });
    return {
      artifact,
      frameCount: recording.frameTimestamps.length,
      durationMs: Math.max(0, endedAt - recording.startedAt),
      encoder: "ffmpeg",
    };
  } finally {
    await rm(recording.frameDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
