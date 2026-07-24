/**
 * Environment resolution for the voice control plane.
 *
 * The voice controller is a small, fast LLM turn that decides between a
 * direct spoken answer, a bounded direct operation, a clarification, or
 * delegation into full Cesium agent conversations. Its provider config is
 * resolved from env, mirroring the cesium-agent bootstrap conventions:
 *
 * - `OPENCURSOR_VOICE_BASE_URL`  -> `CESIUM_BASE_URL` -> `OPENAI_BASE_URL`
 * - `OPENCURSOR_VOICE_API_KEY`   -> `CESIUM_API_KEY`  -> `OPENAI_API_KEY`
 * - `OPENCURSOR_VOICE_MODEL`     -> `CESIUM_DEFAULT_MODEL` -> "glm-5.2"
 */

export type VoiceControllerEnv = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed;
}

export function voiceControllerEnv(
  env: NodeJS.ProcessEnv = process.env
): VoiceControllerEnv {
  const baseUrl = normalizeBaseUrl(
    env.OPENCURSOR_VOICE_BASE_URL ??
      env.CESIUM_BASE_URL ??
      env.OPENAI_BASE_URL ??
      ""
  );
  const apiKey = (
    env.OPENCURSOR_VOICE_API_KEY ??
    env.CESIUM_API_KEY ??
    env.OPENAI_API_KEY ??
    ""
  ).trim();
  const model = (
    env.OPENCURSOR_VOICE_MODEL ??
    env.CESIUM_DEFAULT_MODEL ??
    "glm-5.2"
  ).trim();
  return { baseUrl, apiKey, model };
}

export function isVoiceControllerConfigured(env?: NodeJS.ProcessEnv): boolean {
  const { baseUrl, apiKey, model } = voiceControllerEnv(env);
  return Boolean(baseUrl && apiKey && model);
}

/**
 * Optional JSON merged into every controller chat/completions body. Lets a
 * deployment disable provider-specific reasoning or set sampling knobs
 * without code changes, e.g. `{"temperature":0.2}`.
 */
export function voiceControllerExtraBody(
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const raw = env.OPENCURSOR_VOICE_EXTRA_BODY?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed overrides; the base request body still works.
  }
  return {};
}
