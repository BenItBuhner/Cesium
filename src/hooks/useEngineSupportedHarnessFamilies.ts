"use client";

import { useEffect, useState } from "react";
import { harnessFamilyForBackend, type HarnessFamilyId } from "@cesium/core";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { listEngineBackends } from "@/lib/onboarding/engine-api";

/**
 * Harness families the active engine can actually execute, fetched straight
 * from its `/api/agents/backends` catalog. Real servers advertise every
 * harness family; the in-page Browser Machine only advertises in-page ones,
 * so settings surfaces can hide controls for harnesses that do not exist on
 * the connected engine. Returns null while unknown (no engine, catalog still
 * loading, or the fetch failed) - callers should not filter in that case.
 */
export function useEngineSupportedHarnessFamilies(): Set<HarnessFamilyId> | null {
  const { activeServer, hasServer } = useServerConnections();
  const [supported, setSupported] = useState<Set<HarnessFamilyId> | null>(null);
  const baseUrl = hasServer ? activeServer.baseUrl : null;

  useEffect(() => {
    let cancelled = false;
    setSupported(null);
    if (!baseUrl) {
      return;
    }
    void listEngineBackends(baseUrl)
      .then((result) => {
        if (cancelled || result.backends.length === 0) {
          return;
        }
        const families = new Set<HarnessFamilyId>();
        for (const backend of result.backends) {
          const family = harnessFamilyForBackend(backend.id);
          if (family) {
            families.add(family.id);
          }
        }
        setSupported(families);
      })
      .catch(() => {
        // Unknown catalog (offline engine, auth) - leave null so the settings
        // UI shows the unfiltered list instead of hiding everything.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return supported;
}
