"use client";

import { useEffect, useRef } from "react";
import { useOptionalProjects } from "./ProjectsProvider";

/**
 * A side-pane Project tab saved by an older build: Projects have their own
 * page now, so it opens that page and closes itself.
 */
export function ProjectTabRedirect({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const projects = useOptionalProjects();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) {
      return;
    }
    handled.current = true;
    onDone();
    if (projects?.enabled && projects.activeProjectId !== projectId) {
      void projects.openProjectById(projectId).catch(() => undefined);
    }
  }, [onDone, projectId, projects]);
  return null;
}
