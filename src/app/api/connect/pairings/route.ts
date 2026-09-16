import { getPairingCloud } from "@/lib/connect-pairing-cloud";
import { handlePairingCreate } from "@/lib/connect-pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function unavailable(error: unknown): Response {
  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "Engine pairing is temporarily unavailable.",
    },
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

/** Engine registers a pending `/connect/<code>` pairing. */
export async function POST(request: Request): Promise<Response> {
  let cloud;
  try {
    cloud = getPairingCloud();
  } catch (error) {
    console.error("[connect] pairing cloud unavailable:", error);
    return unavailable(error);
  }
  return await handlePairingCreate(cloud, request);
}
