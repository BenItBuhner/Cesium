"use client";

import { ArrowUp, LoaderCircle, Pause, Play, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentConversationStatus } from "@/lib/agent-types";
import {
  isAgentCesiumPauseDraining,
  isAgentConversationPaused,
} from "@/lib/agent-chat";
import {
  CESIUM_TURN_PILL_TRANSITION_MS,
  prefersCesiumTurnPillReducedMotion,
} from "@/components/chat/cesium-turn-control-motion";

type CesiumTurnControlPillProps = {
  expanded: boolean;
  conversationStatus?: AgentConversationStatus;
  toneClass: string;
  onPause?: () => Promise<void> | void;
  onResume?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onSend?: () => Promise<void> | void;
  sendDisabled?: boolean;
  sendLabel?: string;
  /** Pause/stop stay clickable only while the turn controls are the live target. */
  interactive?: boolean;
};

/** Each control square matches the composer's shared send-button diameter. */
const SQUARE_BUTTON_CLASS =
  "relative flex h-[var(--d2-composer-send-size)] w-[var(--d2-composer-send-size)] shrink-0 touch-manipulation items-center justify-center transition-opacity hover:opacity-80 disabled:cursor-default";

const ICON_LAYER_CLASS =
  "absolute inset-0 flex items-center justify-center transition-opacity motion-reduce:transition-none";

function iconLayerStyle(visible: boolean): { opacity: number; transitionDuration: string } {
  return {
    opacity: visible ? 1 : 0,
    transitionDuration: `${CESIUM_TURN_PILL_TRANSITION_MS}ms`,
  };
}

function IconLayer({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <span className={ICON_LAYER_CLASS} style={iconLayerStyle(visible)} aria-hidden={!visible}>
      {children}
    </span>
  );
}

export function CesiumTurnControlPill({
  expanded,
  conversationStatus,
  toneClass,
  onPause,
  onResume,
  onStop,
  onSend,
  sendDisabled = false,
  sendLabel = "Send",
  interactive = true,
}: CesiumTurnControlPillProps): ReactElement {
  const [pausePending, setPausePending] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const inFlightRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWidthRef = useRef<number | null>(null);

  const draining = conversationStatus ? isAgentCesiumPauseDraining(conversationStatus) : false;
  const paused = conversationStatus ? isAgentConversationPaused(conversationStatus) : false;
  const showPauseLoader = draining || pausePending;
  /** Collapse immediately on Stop so we don't sit expanded until cancel lands. */
  const visuallyExpanded = expanded && !stopPending;
  const showSendIcon = !visuallyExpanded && !sendDisabled && !stopPending;
  const turnControlsLive = visuallyExpanded && interactive;

  useEffect(() => {
    if (!draining) {
      setPausePending(false);
    }
    if (!paused) {
      setResumePending(false);
    }
  }, [draining, paused]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const sendSize =
      Number.parseFloat(
        getComputedStyle(el).getPropertyValue("--d2-composer-send-size")
      ) || 24;
    const to = visuallyExpanded ? sendSize * 2 : sendSize;
    const from = lastWidthRef.current ?? sendSize;
    el.style.minWidth = "0px";
    el.style.width = `${to}px`;
    if (prefersCesiumTurnPillReducedMotion() || Math.abs(from - to) < 0.5) {
      lastWidthRef.current = to;
      return;
    }
    const animation = el.animate(
      [{ width: `${from}px` }, { width: `${to}px` }],
      {
        duration: CESIUM_TURN_PILL_TRANSITION_MS,
        easing: "cubic-bezier(0.24, 0.9, 0.3, 1)",
      }
    );
    // Animation.finished (the promise) only exists since Chromium 84; the
    // Android 11 system WebView ships 83, where reading .then off it crashed
    // the whole workbench the moment this pill mounted. onfinish is Web
    // Animations v1 and covers those engines.
    const commitWidth = () => {
      lastWidthRef.current = to;
    };
    if (animation.finished) {
      void animation.finished.then(commitWidth, () => {
        /* cancelled - cleanup records the in-flight width */
      });
    } else {
      animation.onfinish = commitWidth;
    }
    return () => {
      lastWidthRef.current = el.getBoundingClientRect().width;
      animation.cancel();
    };
  }, [visuallyExpanded]);

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
  const primaryLabel = showSendIcon ? sendLabel : pauseResumeLabel;
  const primaryDisabled = showSendIcon
    ? sendDisabled || !onSend
    : !turnControlsLive || showPauseLoader || resumePending;

  return (
    <div
      ref={rootRef}
      className={`flex h-[var(--d2-composer-send-size)] min-w-0 shrink-0 items-center gap-0 overflow-hidden rounded-full ${toneClass} ${
        visuallyExpanded
          ? "w-[calc(var(--d2-composer-send-size)*2)]"
          : "w-[var(--d2-composer-send-size)]"
      }`}
      aria-label="Cesium agent controls"
      data-cesium-turn-pill=""
      data-expanded={visuallyExpanded ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => {
          if (showSendIcon) {
            void onSend?.();
            return;
          }
          if (!turnControlsLive) {
            return;
          }
          if (paused) {
            void runGuarded("resume", onResume);
            return;
          }
          if (!showPauseLoader) {
            void runGuarded("pause", onPause);
          }
        }}
        disabled={primaryDisabled}
        className={`${SQUARE_BUTTON_CLASS} disabled:opacity-100`}
        aria-label={primaryLabel}
        title={primaryLabel}
      >
        <IconLayer visible={showSendIcon}>
          <ArrowUp className="size-[14px] text-[var(--bg-main)]" strokeWidth={2.5} />
        </IconLayer>
        <IconLayer visible={!showSendIcon && (showPauseLoader || stopPending)}>
          <LoaderCircle
            className="size-[10px] shrink-0 animate-spin text-[var(--bg-main)]"
            strokeWidth={2.5}
          />
        </IconLayer>
        <IconLayer visible={!showSendIcon && !showPauseLoader && !stopPending && paused}>
          <Play
            className="size-[10px] shrink-0 text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
          />
        </IconLayer>
        <IconLayer visible={!showSendIcon && !showPauseLoader && !stopPending && !paused}>
          <Pause
            className="size-[10px] shrink-0 text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
          />
        </IconLayer>
      </button>
      <button
        type="button"
        onClick={() => {
          if (!turnControlsLive) {
            return;
          }
          void runGuarded("stop", onStop);
        }}
        disabled={!turnControlsLive || stopPending}
        tabIndex={visuallyExpanded ? 0 : -1}
        className={`${SQUARE_BUTTON_CLASS} disabled:opacity-100`}
        style={iconLayerStyle(visuallyExpanded)}
        aria-hidden={!visuallyExpanded}
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
            className="size-[10px] text-[var(--bg-main)]"
            fill="currentColor"
            strokeWidth={2.2}
            aria-hidden
          />
        )}
      </button>
    </div>
  );
}
