"use client";

/**
 * The ambient voice orb: a draggable, animated presence that replaces any
 * chat-log UI. Tap toggles listening (or interrupts speech), drag moves it
 * anywhere, right-click / long-press opens a compact icon menu. Transient
 * caption bubbles stack toward the viewport center.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Mic, MicOff, Pause, VolumeX } from "lucide-react";
import { drawOrb } from "@/lib/voice/orb-renderer";
import {
  bubbleAnchor,
  clampOrbPosition,
  defaultOrbPosition,
  isClickGesture,
  ORB_SIZE,
  type OrbPosition,
} from "@/lib/voice/orb-utils";
import { useVoice } from "./VoiceProvider";
import { VoiceBubbles } from "./VoiceBubbles";
import { VoiceOrbMenu } from "./VoiceOrbMenu";

const POSITION_STORAGE_KEY = "cesium.voice.orb.position";
const LONG_PRESS_MS = 550;

function loadStoredPosition(): OrbPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Ignore corrupted storage.
  }
  return null;
}

export function VoiceOrb() {
  const {
    mode,
    activity,
    setMode,
    getOrbLevels,
    interrupt,
    queuedDigestCount,
    error,
  } = useVoice();

  const [position, setPosition] = useState<OrbPosition>(() => ({
    x: -9999,
    y: -9999,
  }));
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const gestureRef = useRef<{
    pointerId: number;
    downX: number;
    downY: number;
    startedAt: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial position: stored or bottom-right.
  useLayoutEffect(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const stored = loadStoredPosition();
    setPosition(
      stored ? clampOrbPosition(stored, viewport) : defaultOrbPosition(viewport)
    );
  }, []);

  // Keep the orb on screen across resizes.
  useEffect(() => {
    const onResize = () => {
      setPosition((current) =>
        clampOrbPosition(current, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Canvas animation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = ORB_SIZE * dpr;
    canvas.height = ORB_SIZE * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const render = (time: number) => {
      const levels = getOrbLevels();
      const currentActivity = activityRef.current;
      const level =
        currentActivity === "speaking"
          ? levels.tts
          : currentActivity === "capturing" || currentActivity === "listening"
            ? levels.mic
            : 0;
      drawOrb(ctx, ORB_SIZE, {
        activity: currentActivity,
        mode: modeRef.current,
        level,
        timeMs: time,
      });
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [getOrbLevels]);

  const persistPosition = useCallback((next: OrbPosition) => {
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable; position just won't persist.
    }
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button === 2) return; // context menu handled separately
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = {
        pointerId: event.pointerId,
        downX: event.clientX,
        downY: event.clientY,
        startedAt: performance.now(),
        offsetX: event.clientX - positionRef.current.x,
        offsetY: event.clientY - positionRef.current.y,
        moved: false,
      };
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        if (gestureRef.current && !gestureRef.current.moved) {
          gestureRef.current = null;
          setMenuOpen(true);
        }
      }, LONG_PRESS_MS);
    },
    [clearLongPress]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const distance = Math.hypot(
        event.clientX - gesture.downX,
        event.clientY - gesture.downY
      );
      if (!gesture.moved && distance > 6) {
        gesture.moved = true;
        setDragging(true);
        clearLongPress();
      }
      if (gesture.moved) {
        const next = clampOrbPosition(
          {
            x: event.clientX - gesture.offsetX,
            y: event.clientY - gesture.offsetY,
          },
          { width: window.innerWidth, height: window.innerHeight }
        );
        setPosition(next);
      }
    },
    [clearLongPress]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      clearLongPress();
      setDragging(false);
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (gesture.moved) {
        persistPosition(positionRef.current);
        return;
      }
      const click = isClickGesture({
        downX: gesture.downX,
        downY: gesture.downY,
        upX: event.clientX,
        upY: event.clientY,
        durationMs: performance.now() - gesture.startedAt,
      });
      if (!click) return;
      // Tap: interrupt speech first; otherwise toggle listening.
      if (activityRef.current === "speaking") {
        interrupt();
        return;
      }
      setMode(modeRef.current === "off" ? "active" : "off");
    },
    [clearLongPress, interrupt, persistPosition, setMode]
  );

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setMenuOpen((open) => !open);
  }, []);

  if (position.x < -1000) {
    return null; // Waiting for the initial layout measurement.
  }

  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1280, height: 800 };
  const anchor = bubbleAnchor(position, viewport);

  const modeBadge =
    mode === "off" ? (
      <MicOff className="size-3 text-[var(--text-secondary)]" />
    ) : mode === "paused" ? (
      <Pause className="size-3 text-amber-600" />
    ) : mode === "quiet" ? (
      <VolumeX className="size-3 text-sky-600" />
    ) : (
      <Mic className="size-3 text-emerald-600" />
    );

  return (
    <div
      className="fixed z-[80] select-none"
      style={{ left: position.x, top: position.y, width: ORB_SIZE, height: ORB_SIZE }}
      data-testid="voice-orb-root"
    >
      <VoiceBubbles anchor={anchor} />
      {menuOpen ? (
        <VoiceOrbMenu anchor={anchor} onClose={() => setMenuOpen(false)} />
      ) : null}
      <div
        role="button"
        aria-label="Cesium voice orb"
        title="Tap: toggle voice · drag: move · long-press or right-click: menu"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        className={`relative size-full touch-none rounded-full transition-shadow ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        } ${
          activity === "speaking"
            ? "shadow-[0_0_36px_rgba(160,170,190,0.55)]"
            : activity === "capturing"
              ? "shadow-[0_0_30px_rgba(120,200,160,0.5)]"
              : "shadow-[0_6px_26px_rgba(0,0,0,0.35)]"
        }`}
        data-testid="voice-orb"
        data-voice-mode={mode}
        data-voice-activity={activity}
      >
        <canvas
          ref={canvasRef}
          style={{ width: ORB_SIZE, height: ORB_SIZE }}
          className="pointer-events-none rounded-full"
        />
        <span className="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-full border border-[var(--border-card)] bg-[var(--bg-card)] shadow-sm">
          {modeBadge}
        </span>
        {queuedDigestCount > 0 ? (
          <span
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white"
            data-testid="voice-orb-digest-badge"
          >
            {queuedDigestCount}
          </span>
        ) : null}
        {error ? (
          <span
            className="absolute -top-1 left-0 size-2.5 rounded-full bg-red-500"
            title={error}
          />
        ) : null}
      </div>
    </div>
  );
}
