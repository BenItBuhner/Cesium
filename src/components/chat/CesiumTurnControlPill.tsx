"use client";

import { LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentConversationStatus } from "@/lib/agent-types";
import {
  isAgentCesiumPauseDraining,
  isAgentConversationPaused,
} from "@/lib/agent-chat";

type CesiumTurnControlPillProps = {
  conversationStatus?: AgentConversationStatus;
  toneClass: string;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
};

const SQUARE_BUTTON_CLASS =
  "flex h-[20px] w-[20px] shrink-0 items-center justify-center transition-opacity hover:opacity-80 disabled:cursor-default";

export function CesiumTurnControlPill({
  conversationStatus,
  toneClass,
  onPause,
  onResume,
  onStop,
}: CesiumTurnControlPillProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const inFlightRef = useRef(false);

  const draining = conversationStatus ? isAgentCesiumPauseDraining(conversationStatus) : false;
  const paused = conversationStatus ? isAgentConversationPaused(conversationStatus) : false;
  const showPauseLoader = draining || pausePending;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!draining) {
      setPausePending(false);
    }
    if (!paused) {
      setResumePending(false);
    }
  }, [draining, paused]);

  const runGuarded = useCallback(
    async (action: "pause" | "resume" | "stop", fn?: () => Promise<void> | void) => {
      if (!fn || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      if (action === "pause") {
        setPausePending(true);
      } else if (action === "resume") {
        setResumePending(true);
      } else {
        setStopPending(true);
      }
      try {
        await fn();
      } finally {
        inFlightRef.current = false;
        if (action === "pause") {
          setPausePending(false);
        } else if (action === "resume") {
          setResumePending(false);
        } else {
          setStopPending(false);
        }
      }
    },
    []
  );

  const pauseResumeLabel = paused
    ? "Resume Cesium agent"
    : showPauseLoader
      ? "Pausing Cesium agent"
      : "Pause Cesium agent";

  return (
    <div
      className={`flex h-[20px] shrink-0 items-center gap-0 overflow-hidden rounded-full transition-[width] duration-300 ease-out ${toneClass} ${
        expanded ? "w-[40px]" : "w-[20px]"
      }`}
      aria-label="Cesium agent controls"
    >
      <button
        type="button"
        onClick={() => {
          if (paused) {
            void runGuarded("resume", onResume);
            return;
          }
          if (!showPauseLoader) {
            void runGuarded("pause", onPause);
          }
        }}
        disabled={showPauseLoader || resumePending}
        className={`${SQUARE_BUTTON_CLASS} disabled:opacity-100`}
        aria-label={pauseResumeLabel}
        title={pauseResumeLabel}
      >
        {showPauseLoader ? (
          <LoaderCircle
            className="size-[10px] shrink-0 animate-spin text-[var(--bg-main)]"
            strokeWidth={2.5}
            aria-hidden
          />
        ) : paused ? (
          <Play
            className="size-[9px] shrink-0 text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
            aria-hidden
          />
        ) : (
          <Pause
            className="size-[9px] shrink-0 text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
            aria-hidden
          />
        )}
      </button>
      <button
        type="button"
        onClick={() => void runGuarded("stop", onStop)}
        disabled={stopPending}
        className={`${SQUARE_BUTTON_CLASS} disabled:opacity-100`}
        aria-label="Stop Cesium agent"
        title="Stop Cesium agent"
      >
        {stopPending ? (
          <LoaderCircle
            className="size-[10px] shrink-0 animate-spin text-[var(--bg-main)]"
            strokeWidth={2.5}
            aria-hidden
          />
        ) : (
          <Square
            className="size-[9px] text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
            aria-hidden
          />
        )}
      </button>
    </div>
  );
}
