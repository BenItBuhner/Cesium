#!/usr/bin/env node
/**
 * Fetches the browser-side Silero VAD assets into public/voice/ so the live
 * voice pipeline can upgrade from the energy VAD to Silero VAD v5:
 *
 *   public/voice/silero_vad_v5.onnx   (model, ~2.3 MB)
 *   public/voice/ort/*                (onnxruntime-web wasm + loaders)
 *
 * Assets are intentionally NOT committed (see .gitignore); run
 * `npm run voice:assets` once per checkout. Without them the voice plane
 * still works — the energy VAD is used instead.
 */

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = path.join(repoRoot, "public", "voice");
const ortDir = path.join(voiceDir, "ort");

const SILERO_URLS = [
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/silero_vad_v5.onnx",
  "https://unpkg.com/@ricky0123/vad-web@0.0.24/dist/silero_vad_v5.onnx",
];

async function downloadSileroModel() {
  const target = path.join(voiceDir, "silero_vad_v5.onnx");
  try {
    const stat = await fs.stat(target);
    if (stat.size > 1_000_000) {
      console.log(`[voice-assets] model already present (${stat.size} bytes)`);
      return;
    }
  } catch {
    // Missing; download below.
  }
  for (const url of SILERO_URLS) {
    try {
      console.log(`[voice-assets] downloading ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length < 1_000_000) throw new Error("suspiciously small model");
      await fs.writeFile(target, data);
      console.log(`[voice-assets] saved silero_vad_v5.onnx (${data.length} bytes)`);
      return;
    } catch (error) {
      console.warn(`[voice-assets] ${url} failed: ${error.message}`);
    }
  }
  throw new Error("Could not download the Silero VAD model from any mirror.");
}

async function copyOrtRuntime() {
  // onnxruntime-web's exports map hides package.json; resolve the module
  // entry (dist/ort.min.mjs or similar) and use its directory.
  let distDir = path.join(repoRoot, "node_modules", "onnxruntime-web", "dist");
  try {
    await fs.stat(distDir);
  } catch {
    distDir = path.dirname(require.resolve("onnxruntime-web"));
  }
  const entries = await fs.readdir(distDir);
  const wanted = entries.filter(
    (entry) => entry.endsWith(".wasm") || entry.endsWith(".mjs")
  );
  let copied = 0;
  for (const entry of wanted) {
    await fs.copyFile(path.join(distDir, entry), path.join(ortDir, entry));
    copied++;
  }
  console.log(`[voice-assets] copied ${copied} onnxruntime-web files to public/voice/ort/`);
}

await fs.mkdir(ortDir, { recursive: true });
await downloadSileroModel();
await copyOrtRuntime();
console.log("[voice-assets] done");
