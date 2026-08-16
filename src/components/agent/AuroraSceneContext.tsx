"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuroraMood, AuroraPlacement } from "@/lib/aurora/aurora-renderer";

export type AuroraScene = {
  mood: AuroraMood;
  placement: AuroraPlacement;
};

type AuroraSceneContextValue = {
  scene: AuroraScene;
  setScene: (scene: AuroraScene) => void;
};

const DEFAULT_SCENE: AuroraScene = { mood: "idle", placement: "top" };

/**
 * Bridges the conversation pane (which derives the aurora mood/placement from
 * live conversation state) to a shell-level backdrop that spans the whole
 * window behind the rail, center pane, and editor panels.
 *
 * When no provider is mounted (e.g. surfaces outside the desktop shell), the
 * pane falls back to rendering its own pane-local backdrop.
 */
const AuroraSceneContext = createContext<AuroraSceneContextValue | null>(null);

export function AuroraSceneProvider({ children }: { children: ReactNode }) {
  const [scene, setSceneState] = useState<AuroraScene>(DEFAULT_SCENE);
  const setScene = useCallback((next: AuroraScene) => {
    setSceneState((current) =>
      current.mood === next.mood && current.placement === next.placement
        ? current
        : next
    );
  }, []);
  const value = useMemo(() => ({ scene, setScene }), [scene, setScene]);
  return (
    <AuroraSceneContext.Provider value={value}>{children}</AuroraSceneContext.Provider>
  );
}

/** Null when no shell-level aurora host is mounted. */
export function useAuroraScene(): AuroraSceneContextValue | null {
  return useContext(AuroraSceneContext);
}
