"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatMessage, ExplorerOpenRequest } from "@/lib/types";

export type OpenTranscriptPayload = {
  title: string;
  messages: ChatMessage[];
};

type TranscriptHandler = (payload: OpenTranscriptPayload) => void;
type ExplorerHandler = (payload: ExplorerOpenRequest) => void;

type Ctx = {
  registerOpenTranscript: (handler: TranscriptHandler | null) => void;
  openSubagentTranscript: (payload: OpenTranscriptPayload) => void;
  registerOpenExplorerFile: (handler: ExplorerHandler | null) => void;
  openExplorerFile: (payload: ExplorerOpenRequest) => void;
  activeExplorerPath: string | null;
  setActiveExplorerPath: (path: string | null) => void;
};

const OpenInEditorContext = createContext<Ctx | null>(null);

export function OpenInEditorProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<TranscriptHandler | null>(null);
  const pendingRef = useRef<OpenTranscriptPayload | null>(null);
  const explorerRef = useRef<ExplorerHandler | null>(null);
  const pendingExplorerRef = useRef<ExplorerOpenRequest | null>(null);
  const [activeExplorerPath, setActiveExplorerPath] = useState<string | null>(null);

  const registerOpenTranscript = useCallback((handler: TranscriptHandler | null) => {
    handlerRef.current = handler;
    if (handler && pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = null;
      handler(p);
    }
  }, []);

  const openSubagentTranscript = useCallback((payload: OpenTranscriptPayload) => {
    if (handlerRef.current) {
      handlerRef.current(payload);
    } else {
      pendingRef.current = payload;
    }
  }, []);

  const registerOpenExplorerFile = useCallback((handler: ExplorerHandler | null) => {
    explorerRef.current = handler;
    if (handler && pendingExplorerRef.current) {
      const p = pendingExplorerRef.current;
      pendingExplorerRef.current = null;
      handler(p);
    }
  }, []);

  const openExplorerFile = useCallback((payload: ExplorerOpenRequest) => {
    setActiveExplorerPath(payload.path);
    if (explorerRef.current) {
      explorerRef.current(payload);
    } else {
      pendingExplorerRef.current = payload;
    }
  }, []);

  const value = useMemo(
    () => ({
      registerOpenTranscript,
      openSubagentTranscript,
      registerOpenExplorerFile,
      openExplorerFile,
      activeExplorerPath,
      setActiveExplorerPath,
    }),
    [
      registerOpenTranscript,
      openSubagentTranscript,
      registerOpenExplorerFile,
      openExplorerFile,
      activeExplorerPath,
    ]
  );

  return (
    <OpenInEditorContext.Provider value={value}>
      {children}
    </OpenInEditorContext.Provider>
  );
}

export function useOpenInEditor(): Ctx {
  const ctx = useContext(OpenInEditorContext);
  if (!ctx) {
    throw new Error("useOpenInEditor must be used within OpenInEditorProvider");
  }
  return ctx;
}
