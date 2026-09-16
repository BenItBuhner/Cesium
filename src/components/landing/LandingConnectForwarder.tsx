"use client";

import { useEffect } from "react";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

/**
 * Engine connect links that predate the workbench-scoped URL land on the
 * marketing page (`/?serverUrl=...`, `/#cesiumConnect=...`). The landing page
 * has no server-connection provider and every CTA drops the query, so the
 * parameter used to vanish silently. Forward such visits to the workbench,
 * which consumes them.
 */
export function landingConnectForwardTarget(location: {
  search: string;
  hash: string;
}): string | null {
  const hasServerUrl = new URLSearchParams(location.search).has("serverUrl");
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hashParams = new URLSearchParams(hash);
  const hasConnectFragment = hashParams.has("cesiumConnect") || hashParams.has("cesiumSession");
  if (!hasServerUrl && !hasConnectFragment) {
    return null;
  }
  return `${WORKSPACE_ROUTE}${location.search}${location.hash}`;
}

export function LandingConnectForwarder() {
  useEffect(() => {
    const target = landingConnectForwardTarget(window.location);
    if (target) {
      window.location.replace(target);
    }
  }, []);
  return null;
}
