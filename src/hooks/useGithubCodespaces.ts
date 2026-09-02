"use client";

import {
  probeEngineHealthy,
  useCodespaces,
  type CodespaceWakeFailure,
  type CodespaceWakeStatus,
} from "@/contexts/CodespacesContext";

export { probeEngineHealthy };
export type { CodespaceWakeFailure, CodespaceWakeStatus };

/**
 * GitHub Codespace devices for the device picker. Thin alias over the shared
 * {@link useCodespaces} controller so the picker, the rail and the composer
 * all observe one wake state machine (see CodespacesContext).
 */
export function useGithubCodespaces() {
  return useCodespaces();
}
