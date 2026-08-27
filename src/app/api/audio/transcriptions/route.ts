export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function headerValue(request: Request, name: string): string {
  return request.headers.get(name)?.trim() || "";
}

export async function POST(request: Request): Promise<Response> {
  const baseUrl = headerValue(request, "x-cesium-provider-base");
  const apiKey = headerValue(request, "x-cesium-provider-key");
  const model = headerValue(request, "x-cesium-provider-model");
  if (!baseUrl || !apiKey || !model) {
    return Response.json(
      { error: "Missing account transcription provider headers." },
      { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart audio upload." },
      { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { error: "Expected audio file upload." },
      { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const language =
    (typeof form.get("language") === "string" ? String(form.get("language")) : "").trim() ||
    undefined;
  const prompt =
    (typeof form.get("prompt") === "string" ? String(form.get("prompt")) : "").trim() ||
    undefined;

  const upstream = new URL("audio/transcriptions", normalizeBaseUrl(baseUrl)).toString();
  const outbound = new FormData();
  outbound.set("model", model);
  outbound.set("response_format", "json");
  if (language) {
    outbound.set("language", language);
  }
  if (prompt) {
    outbound.set("prompt", prompt);
  }
  outbound.set("file", file);

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outbound,
      cache: "no-store",
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Transcription provider request failed.",
      },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const rawText = await response.text();
  if (!response.ok) {
    return Response.json(
      { error: rawText || "Transcription provider request failed." },
      {
        status: response.status >= 400 && response.status < 600 ? response.status : 502,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  let payload: unknown = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }
  const text =
    typeof (payload as { text?: unknown } | null)?.text === "string"
      ? (payload as { text: string }).text.trim()
      : "";
  if (!text) {
    return Response.json(
      { error: "Transcription provider returned no text." },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  return Response.json(
    { text },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
