import { getRendezvousStore } from "@/lib/rendezvous-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const MAX_BATCH_SIZE = 250;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

export async function GET(): Promise<Response> {
  try {
    const store = getRendezvousStore();
    await store.get("healthcheck_000000000000000000000000");
    return Response.json(
      { configured: true },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[rendezvous] configuration check failed:", error);
    return Response.json(
      {
        configured: false,
        error:
          error instanceof Error && error.message.includes("not configured")
            ? error.message
            : "Rendezvous storage is temporarily unavailable.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Retry-After": "15",
        },
      }
    );
  }
}

/**
 * Legacy/custom registry fallback. Current Cesium Cloud clients subscribe to
 * Convex directly; older locators can still resolve every saved server in one
 * Vercel invocation instead of issuing one function call per server.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { serverIds?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (
    !Array.isArray(body.serverIds) ||
    body.serverIds.length > MAX_BATCH_SIZE ||
    body.serverIds.some(
      (serverId) => typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)
    )
  ) {
    return Response.json(
      { error: `serverIds must contain at most ${MAX_BATCH_SIZE} valid ids.` },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  const serverIds = [...new Set(body.serverIds as string[])];
  try {
    const records = await getRendezvousStore().getMany(serverIds);
    return Response.json({ records }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[rendezvous] batch lookup failed:", error);
    return Response.json(
      { error: "Rendezvous storage is temporarily unavailable." },
      {
        status: 503,
        headers: { ...NO_STORE_HEADERS, "Retry-After": "30" },
      }
    );
  }
}
