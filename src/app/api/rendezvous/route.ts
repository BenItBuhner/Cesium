import { getRendezvousStore } from "@/lib/rendezvous-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    const store = getRendezvousStore();
    await store.get("healthcheck_000000000000000000000000");
    return Response.json(
      { configured: true },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
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
