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
import type {
  EditorGroup,
  EditorPanelAction,
  EditorPanelState,
} from "@/components/editor/editor-panel-state";
import type { BrowserControlTab, BrowserControlViewport } from "@/lib/server-api";

export type EditorBridge = {
  dispatch: Dispatch<EditorPanelAction>;
  getState: () => EditorPanelState;
  saveActiveTab: () => Promise<boolean>;
  saveAllTabs: () => Promise<{ savedCount: number; attemptedCount: number }>;
  openTerminalTab: () => Promise<void>;
  openBrowserTab: (
    url: string,
    options?: { group?: EditorGroup; activate?: boolean; engine?: "proxy" | "server-chromium" }
  ) => Promise<string | null> | string | null | void;
  listBrowserTabs?: () => BrowserControlTab[];
  closeBrowserTab?: (tabId: string) => Promise<boolean> | boolean;
  focusBrowserTab?: (tabId: string) => Promise<boolean> | boolean;
  moveBrowserTab?: (tabId: string, group: EditorGroup) => Promise<boolean> | boolean;
  navigateBrowserTab?: (
    tabId: string,
    input: { op: "goto"; url: string } | { op: "reload" | "back" | "forward" }
  ) => Promise<boolean> | boolean;
  updateBrowserLock?: (
    tabId: string,
    input: { locked: boolean; conversationId?: string | null; reason?: string | null }
  ) => Promise<boolean> | boolean;
  setBrowserViewport?: (
    tabId: string,
    viewport: Partial<BrowserControlViewport>
  ) => Promise<boolean> | boolean;
  openOrchestrationBoardTab: (
    boardId: string,
    title: string,
    group?: EditorGroup
  ) => void;
  requestCloseTab: (group: EditorGroup, id: string) => void;
  requestCloseAllInGroup: (group: EditorGroup) => void;
  requestCloseOthersInGroup: (group: EditorGroup) => void;
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
