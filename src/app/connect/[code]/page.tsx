import type { Metadata } from "next";
import { EngineConnectApproval } from "@/components/connect/EngineConnectApproval";

export const metadata: Metadata = {
  title: "Attach engine - Cesium",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One-link engine attach: `cesium-server connect` prints this URL. The page
 * runs entirely client-side against the cloud context (sign-in gate,
 * pairing lookup, credential claim from the engine, account writes).
 */
export default async function EngineConnectPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <EngineConnectApproval code={code} />;
}
