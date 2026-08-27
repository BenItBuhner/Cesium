"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSkillCatalogItem } from "@cesium/core";
import { fetchWorkspaceSkills } from "@/lib/server-api";

export function useWorkspaceSkillCatalog(workspaceId: string | null): {
  skills: WorkspaceSkillCatalogItem[];
  loading: boolean;
  error: string | null;
} {
  const [skills, setSkills] = useState<WorkspaceSkillCatalogItem[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setSkills([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void fetchWorkspaceSkills(workspaceId, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setSkills(result.skills);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setSkills([]);
        setLoading(false);
        setError(cause instanceof Error ? cause.message : "Failed to load skills.");
      });

    return () => controller.abort();
  }, [workspaceId]);

  return { skills, loading, error };
}
