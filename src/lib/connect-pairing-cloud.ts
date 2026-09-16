import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import { getConvexUrl } from "@/lib/cloud/cloud-flags";
import type { PairingCloud } from "./connect-pairing-route";

/** Convex-backed `PairingCloud` for the `/api/connect/*` routes. */
export function getPairingCloud(): PairingCloud {
  const url = getConvexUrl();
  if (!url) {
    throw new Error(
      "Cesium Cloud is not configured on this deployment, so engines cannot be attached by link."
    );
  }
  const client = new ConvexHttpClient(url);
  return {
    async create(input) {
      return await client.mutation(api.pairings.create, input);
    },
    async status(input) {
      return await client.query(api.pairings.status, input);
    },
  };
}
