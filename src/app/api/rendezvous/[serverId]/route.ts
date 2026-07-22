import {
  handleRendezvousGet,
  handleRendezvousPut,
} from "@/lib/rendezvous-route";
import { getRendezvousStore } from "@/lib/rendezvous-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ serverId: string }>;
};

function unavailable(error: unknown): Response {
  const message =
    error instanceof Error && error.message.includes("not configured")
      ? error.message
      : "Rendezvous storage is temporarily unavailable.";
  return Response.json(
    { error: message },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Retry-After": "15",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { serverId } = await context.params;
    return await handleRendezvousGet(getRendezvousStore(), request, serverId);
  } catch (error) {
    console.error("[rendezvous] read failed:", error);
    return unavailable(error);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { serverId } = await context.params;
    return await handleRendezvousPut(getRendezvousStore(), request, serverId);
  } catch (error) {
    console.error("[rendezvous] write failed:", error);
    return unavailable(error);
  }
}
