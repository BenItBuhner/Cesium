import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  runVoiceController,
  type VoiceControllerRequest,
} from "../lib/voice/controller.js";
import {
  isVoiceControllerConfigured,
  voiceControllerEnv,
} from "../lib/voice/voice-env.js";
import {
  listTtsEngineStatuses,
  resolveTtsEngine,
} from "../lib/voice/tts/registry.js";
import {
  isTranscriptionConfigured,
  transcriptionProcessEnv,
} from "../lib/transcription-env.js";

export const voiceRoutes = new Hono();

const MAX_TTS_CHARS = 4000;

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/** Aggregate config status for the voice pill: no secrets, just readiness. */
voiceRoutes.get("/api/voice/status", async (c) => {
  const controller = voiceControllerEnv();
  const transcription = transcriptionProcessEnv();
  const engines = await listTtsEngineStatuses();
  const defaultEngine = await resolveTtsEngine(null);
  return c.json({
    controller: {
      configured: isVoiceControllerConfigured(),
      model: controller.model || null,
      host: controller.baseUrl ? hostOf(controller.baseUrl) : null,
    },
    stt: {
      configured: isTranscriptionConfigured(),
      model: transcription.model || null,
      host: transcription.baseUrl ? hostOf(transcription.baseUrl) : null,
    },
    tts: {
      engines,
      defaultEngine: defaultEngine?.id ?? null,
    },
  });
});

voiceRoutes.get("/api/voice/tts/engines", async (c) => {
  const engines = await listTtsEngineStatuses();
  const defaultEngine = await resolveTtsEngine(null);
  return c.json({ engines, defaultEngine: defaultEngine?.id ?? null });
});

voiceRoutes.post("/api/voice/tts", async (c) => {
  const body = await c.req
    .json<{ text?: string; engine?: string; voice?: string; speed?: number }>()
    .catch(() => null);
  const text = body?.text?.trim();
  if (!text) {
    return c.json({ error: "Expected non-empty text." }, 400);
  }
  if (text.length > MAX_TTS_CHARS) {
    return c.json(
      { error: `Text too long (${text.length} > ${MAX_TTS_CHARS} chars).` },
      400
    );
  }
  const engine = await resolveTtsEngine(body?.engine ?? null);
  if (!engine) {
    return c.json(
      {
        error:
          "No TTS engine available. Install espeak-ng or piper, keep kokoro-js installed, or configure a remote engine.",
      },
      503
    );
  }
  try {
    const result = await engine.synthesize({
      text,
      ...(body?.voice ? { voice: body.voice } : {}),
      ...(typeof body?.speed === "number" ? { speed: body.speed } : {}),
    });
    c.header("Content-Type", result.mimeType);
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("x-cesium-voice-engine", result.engineId);
    c.header("x-cesium-voice-synthesis-ms", String(result.synthesisMs));
    if (result.voice) {
      c.header("x-cesium-voice-voice", result.voice);
    }
    return c.body(new Uint8Array(result.audio));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "TTS synthesis failed.";
    return c.json({ error: message }, 502);
  }
});

voiceRoutes.post("/api/voice/controller", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (!isVoiceControllerConfigured()) {
    return c.json(
      {
        error:
          "Voice controller is not configured. Open Settings → Voice to set a base URL, API key, and model, or set OPENCURSOR_VOICE_* / CESIUM_* environment variables.",
      },
      503
    );
  }
  const body = await c.req.json<VoiceControllerRequest>().catch(() => null);
  if (!body?.utterance?.trim()) {
    return c.json({ error: "Expected utterance." }, 400);
  }
  try {
    const result = await runVoiceController(workspace, {
      utterance: body.utterance,
      ...(Array.isArray(body.history) ? { history: body.history } : {}),
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
    });
    return c.json({ result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Voice controller failed.";
    return c.json({ error: message }, 502);
  }
});
