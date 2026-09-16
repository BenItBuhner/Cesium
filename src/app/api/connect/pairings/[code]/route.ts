import { getPairingCloud } from "@/lib/connect-pairing-cloud";
import { handlePairingStatus } from "@/lib/connect-pairing-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = {
  params: Promise<{ code: string }>;
};

/** Engine polls the outcome of its pairing (bearer: its poll secret). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let cloud;
  try {
    cloud = getPairingCloud();
  } catch (error) {
    console.error("[connect] pairing cloud unavailable:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Engine pairing is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0", "Retry-After": "15" } }
    );
  }
  const { code } = await context.params;
  return await handlePairingStatus(cloud, request, code);
}
