"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";
import { resolveAuroraColors, type AuroraSettingsState } from "@/lib/global-settings";
import {
  createAuroraRenderer,
  type AuroraMood,
  type AuroraRenderer,
} from "@/lib/aurora/aurora-renderer";

/** Background effect — 30fps is plenty and halves the paint work. */
const FRAME_INTERVAL_MS = 1000 / 30;
/** The canvas renders tiny and the element upscales + blurs it via CSS. */
const INTERNAL_SCALE = 1 / 6;
const MIN_INTERNAL_WIDTH = 96;
const MAX_INTERNAL_WIDTH = 300;

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false
  );
}

/**
 * Full-bleed animated aurora layer. Render as the first child of a
 * `relative overflow-hidden` container and keep sibling content positioned
 * (`relative`/`z-10`) so it paints above the canvas.
 *
 * Reads `settings.aurora` from the global settings context; pass
 * `settingsOverride` to drive it directly (settings preview).
 */
export const AuroraBackdrop = memo(function AuroraBackdrop({
  mood,
  settingsOverride,
  className = "",
}: {
  mood: AuroraMood;
  settingsOverride?: AuroraSettingsState;
  className?: string;
}) {
  const { settings } = useGlobalSettings();
  const aurora = settingsOverride ?? settings.aurora;
  const isDark = useHtmlDarkClass();
  const reducedMotion = usePrefersReducedMotion();
  const enabled = aurora.enabled;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<AuroraRenderer | null>(null);

  const colors = useMemo(() => resolveAuroraColors(aurora), [aurora]);
  const colorsKey = colors.join(",");

  const getRenderer = useCallback((): AuroraRenderer => {
    if (!rendererRef.current) {
      rendererRef.current = createAuroraRenderer();
    }
    return rendererRef.current;
  }, []);

  const paintFrame = useCallback(
    (dtMs: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) {
        return;
      }
      getRenderer().render(ctx, canvas.width, canvas.height, dtMs);
    },
    [getRenderer]
  );

  // Push mood/palette/options into the renderer; under reduced motion this is
  // also what repaints the (static) frame.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const renderer = getRenderer();
    renderer.setPalette(colorsKey.split(","));
    renderer.setOptions({ intensity: aurora.intensity, speed: aurora.speed, isDark });
    renderer.setMood(mood);
    if (reducedMotion) {
      renderer.snapToMood();
      paintFrame(0);
    }
  }, [
    enabled,
    colorsKey,
    aurora.intensity,
    aurora.speed,
    isDark,
    mood,
    reducedMotion,
    getRenderer,
    paintFrame,
  ]);

  // Size the internal canvas resolution from the displayed box.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) {
        return;
      }
      const width = Math.round(
        Math.min(MAX_INTERNAL_WIDTH, Math.max(MIN_INTERNAL_WIDTH, box.width * INTERNAL_SCALE))
      );
      const height = Math.max(48, Math.round(width * (box.height / box.width)));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        paintFrame(0);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [enabled, paintFrame]);

  // Animation loop: rAF capped to ~30fps, parked while the tab is hidden.
  useEffect(() => {
    if (!enabled || reducedMotion) {
      return;
    }
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      if (dt < FRAME_INTERVAL_MS) {
        return;
      }
      last = now;
      paintFrame(dt);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) {
      start();
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [enabled, reducedMotion, paintFrame]);

  if (!enabled) {
    return null;
  }

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${className}`}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{
          filter: "blur(22px) saturate(1.3)",
          transform: "scale(1.18)",
          mixBlendMode: isDark ? "screen" : undefined,
        }}
      />
    </div>
  );
});
