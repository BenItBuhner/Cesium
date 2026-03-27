"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { EditorPanelAction, EditorPanelState } from "@/components/editor/editor-panel-state";

export type EditorBridge = {
  dispatch: Dispatch<EditorPanelAction>;
  getState: () => EditorPanelState;
  saveActiveTab: () => Promise<boolean>;
  openTerminalTab: () => Promise<void>;
  openBrowserTab: (url: string) => void;
};

const EditorBridgeRefContext =
  createContext<MutableRefObject<EditorBridge | null> | null>(null);

export function EditorBridgeProvider({ children }: { children: ReactNode }) {
  const ref = useRef<EditorBridge | null>(null);
  const stable = useMemo(() => ref, []);
  return (
    <EditorBridgeRefContext.Provider value={stable}>
      {children}
    </EditorBridgeRefContext.Provider>
  );
}

export function useEditorBridgeRef(): MutableRefObject<EditorBridge | null> {
  const ctx = useContext(EditorBridgeRefContext);
  if (!ctx) {
    throw new Error("useEditorBridgeRef must be used within EditorBridgeProvider");
  }
  return ctx;
}
