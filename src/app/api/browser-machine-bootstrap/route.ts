/**
 * Optional env bootstrap for the Browser Machine, mirroring the engine's
 * `CESIUM_BASE_URL` / `CESIUM_API_KEY` / `CESIUM_DEFAULT_MODEL` bootstrap:
 * a self-hosted deployment can hand the in-browser engine a default
 * OpenAI-compatible inference provider so users get a working Cesium Agent
 * with zero settings work.
 *
 * SECURITY: this intentionally exposes the configured API key to any page
 * visitor, which only makes sense for private/self-hosted deployments. It is
 * therefore disabled unless CESIUM_BROWSER_MACHINE_ENV_BOOTSTRAP=1 is set
 * explicitly.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (process.env.CESIUM_BROWSER_MACHINE_ENV_BOOTSTRAP !== "1") {
    return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const baseUrl = process.env.CESIUM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";
  const apiKey = process.env.CESIUM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!baseUrl || !apiKey) {
    return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const defaultModel = process.env.CESIUM_DEFAULT_MODEL ?? "kimi-k3";
  const hostname = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "custom";
    }
  })();
  const providerId =
    process.env.CESIUM_PROVIDER_ID ??
    (hostname.endsWith("techlitnow.com") ? "techlit" : hostname.replace(/[^a-z0-9]+/gi, "-"));
  const models = (process.env.CESIUM_MODELS ?? defaultModel)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return Response.json(
    {
      enabled: true,
      defaultModelId: `${providerId}/${defaultModel}`,
      provider: {
        id: providerId,
        name: providerId,
        baseUrl,
        apiKind: "openai-chat-completions",
        apiKey,
        models: models.map((modelId) => ({
          providerId,
          providerName: providerId,
          modelId,
          modelName: modelId,
          apiKind: "openai-chat-completions",
          supportsTools: true,
          supportsReasoning: true,
          supportsStructuredOutput: true,
          supportsImages: true,
          contextWindow: 1_000_000,
        })),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
