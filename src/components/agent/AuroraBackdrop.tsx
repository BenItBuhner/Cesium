"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useAuroraScene } from "@/components/agent/AuroraSceneContext";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";
import { resolveAuroraColors, type AuroraSettingsState } from "@/lib/global-settings";
import {
  createAuroraRenderer,
  type AuroraMood,
  type AuroraPlacement,
  type AuroraRenderer,
} from "@/lib/aurora/aurora-renderer";

/** Background effect — 30fps is plenty and halves the paint work. */
const FRAME_INTERVAL_MS = 1000 / 30;
/**
 * Touch devices and low-core machines composite the full-window canvas layer
 * on every tick; 20fps keeps the drift readable while cutting that constant
 * GPU/CPU tax by a third on the hardware that feels it most.
 */
const LOW_POWER_FRAME_INTERVAL_MS = 1000 / 20;
/**
 * Calm moods (idle / paused) drift slowly under a heavy blur — half the frame
 * rate is visually indistinguishable there and halves the standing GPU
 * composite cost of the full-window layer, which is most of what this
 * component costs when the app is just sitting open.
 */
const CALM_FRAME_INTERVAL_MS = 1000 / 15;
const LOW_POWER_CALM_FRAME_INTERVAL_MS = 1000 / 10;
/** Window visible but not focused (another window on top / beside it). */
const UNFOCUSED_FRAME_INTERVAL_MS = 1000 / 8;
/**
 * Every aurora frame damages the whole window, so composite cost scales with
 * DISPLAY pixels (device pixels, not CSS pixels) even though the canvas
 * paints at a tiny internal resolution. Above QHD the drift drops to 20fps
 * and above 4K to 12fps — imperceptible under the heavy blur, but it keeps
 * the standing GPU cost flat instead of quadrupling at 4K and 16x-ing at 8K.
 */
const QHD_DEVICE_PIXELS = 2_560 * 1_440;
const UHD_4K_DEVICE_PIXELS = 3_840 * 2_160;
const LARGE_DISPLAY_FRAME_INTERVAL_MS = 1000 / 20;
const HUGE_DISPLAY_FRAME_INTERVAL_MS = 1000 / 12;

function displayDevicePixels(): number {
  if (typeof window === "undefined") {
    return 0;
  }
  const dpr = window.devicePixelRatio || 1;
  return window.innerWidth * dpr * (window.innerHeight * dpr);
}

let lowPowerDisplayCache: boolean | null = null;
function isLowPowerDisplay(): boolean {
  if (lowPowerDisplayCache === null) {
    const coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const lowConcurrency =
      typeof navigator !== "undefined" &&
      (navigator.hardwareConcurrency ?? 8) <= 4;
    lowPowerDisplayCache = coarsePointer || lowConcurrency;
  }
  return lowPowerDisplayCache;
}

/**
 * GPU-less compositing (SwiftShader / llvmpipe / headless fallbacks) pays for
 * every full-window damage in CPU; the aurora's whole-window canvas is the
 * dominant standing cost there (~38% of a core at 4K/15fps measured under
 * SwiftShader). Such machines get survival frame rates — the drift stays
 * alive, the tax collapses.
 */
let softwareRendererCache: boolean | null = null;
function isSoftwareRenderer(): boolean {
  if (softwareRendererCache !== null) {
    return softwareRendererCache;
  }
  let result = false;
  try {
    const probe = document.createElement("canvas");
    const gl =
      probe.getContext("webgl") ??
      (probe.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) {
      result = true;
    } else {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info
        ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
        : "";
      result = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    result = false;
  }
  softwareRendererCache = result;
  return result;
}

const SOFTWARE_GL_FRAME_INTERVAL_MS = 1000 / 12;
const SOFTWARE_GL_CALM_FRAME_INTERVAL_MS = 1000 / 8;
/** The canvas renders tiny and the element upscales + blurs it via CSS. */
const INTERNAL_SCALE = 1 / 6;
const MIN_INTERNAL_WIDTH = 96;
const MAX_INTERNAL_WIDTH = 300;
/** Softness of the backdrop, expressed in CSS pixels at display size. */
const SOFT_BLUR_CSS_PX = 22;
const SOFT_SATURATE = 1.3;

/**
 * Whether 2D contexts support the `filter` attribute. When they do, the blur
 * runs inside the canvas at the tiny internal resolution (microseconds per
 * frame). A CSS `filter: blur()` on the element instead re-rasterizes the
 * whole full-size layer on every canvas tick, which on machines without GPU
 * compositing collapses global frame production to a few fps — fast
 * transitions elsewhere in the pane (e.g. the composer split FLIP) then
 * complete between two presented frames and look like an instant snap.
 */
let canvasFilterSupport: boolean | null = null;
function supportsCanvasFilter(): boolean {
  if (canvasFilterSupport === null) {
    canvasFilterSupport =
      typeof CanvasRenderingContext2D !== "undefined" &&
      "filter" in CanvasRenderingContext2D.prototype;
  }
  return canvasFilterSupport;
}

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
 * Shell-level aurora host: one canvas spanning the whole window behind the
 * rail, center pane, and editor panels. Renders inside a negative-z wrapper
 * (the shell root uses `isolate`) so every in-flow panel paints above it.
 * The conversation pane publishes mood/placement through the scene context.
 */
export function AuroraShellBackdrop() {
  const sceneContext = useAuroraScene();
  if (!sceneContext) {
    return null;
  }
  return (
    <div aria-hidden className="absolute inset-0 -z-[1]">
      <AuroraBackdrop
        mood={sceneContext.scene.mood}
        placement={sceneContext.scene.placement}
      />
    </div>
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
  placement = "top",
  settingsOverride,
  className = "",
}: {
  mood: AuroraMood;
  placement?: AuroraPlacement;
  settingsOverride?: AuroraSettingsState;
  className?: string;
}) {
  const { settings } = useGlobalSettings();
  const aurora = settingsOverride ?? settings.aurora;
  const isDark = useHtmlDarkClass();
  const reducedMotion = usePrefersReducedMotion();
  const enabled = aurora.enabled;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<AuroraRenderer | null>(null);
  const moodRef = useRef<AuroraMood>(mood);
  moodRef.current = mood;

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
      if (!supportsCanvasFilter()) {
        getRenderer().render(ctx, canvas.width, canvas.height, dtMs);
        return;
      }
      let buffer = bufferRef.current;
      if (!buffer) {
        buffer = document.createElement("canvas");
        bufferRef.current = buffer;
      }
      if (buffer.width !== canvas.width || buffer.height !== canvas.height) {
        buffer.width = canvas.width;
        buffer.height = canvas.height;
      }
      const bufferCtx = buffer.getContext("2d");
      if (!bufferCtx) {
        getRenderer().render(ctx, canvas.width, canvas.height, dtMs);
        return;
      }
      getRenderer().render(bufferCtx, buffer.width, buffer.height, dtMs);
      // A blur of N internal pixels reads as N × upscale CSS pixels once the
      // element stretches the canvas, so divide the designed display-size
      // softness back down by the upscale factor.
      const upscale =
        canvas.clientWidth > 0 ? canvas.clientWidth / canvas.width : 1 / INTERNAL_SCALE;
      const blurPx = Math.max(2, Math.min(8, SOFT_BLUR_CSS_PX / upscale));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.filter = `blur(${blurPx.toFixed(1)}px) saturate(${SOFT_SATURATE})`;
      ctx.drawImage(buffer, 0, 0);
      ctx.filter = "none";
    },
    [getRenderer]
  );

  // The blur lives inside the canvas paint when supported (see
  // `supportsCanvasFilter`); only legacy browsers fall back to the expensive
  // element-level CSS filter. Applied imperatively so server and client
  // render the same markup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.style.filter = supportsCanvasFilter()
      ? ""
      : `blur(${SOFT_BLUR_CSS_PX}px) saturate(${SOFT_SATURATE})`;
  }, [enabled]);

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
    renderer.setPlacement(placement);
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
    placement,
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

  // Animation loop: rAF capped to ~30fps, parked while the tab is hidden or
  // the canvas is scrolled/covered offscreen, slowed while the window is
  // unfocused or the scene is calm (idle/paused).
  useEffect(() => {
    if (!enabled || reducedMotion) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    let offscreen = false;
    let windowBlurred =
      typeof document !== "undefined" && !document.hasFocus();
    const lowPower = isLowPowerDisplay();

    const softwareGl = isSoftwareRenderer();
    const frameIntervalMs = (): number => {
      if (windowBlurred) {
        return UNFOCUSED_FRAME_INTERVAL_MS;
      }
      // Completed conversations sit open indefinitely; after the brief bloom
      // transition the scene is ambient drift, same as idle.
      const calm =
        moodRef.current === "idle" ||
        moodRef.current === "paused" ||
        moodRef.current === "completed";
      let baseInterval = calm
        ? lowPower
          ? LOW_POWER_CALM_FRAME_INTERVAL_MS
          : CALM_FRAME_INTERVAL_MS
        : lowPower
          ? LOW_POWER_FRAME_INTERVAL_MS
          : FRAME_INTERVAL_MS;
      if (softwareGl) {
        baseInterval = Math.max(
          baseInterval,
          calm ? SOFTWARE_GL_CALM_FRAME_INTERVAL_MS : SOFTWARE_GL_FRAME_INTERVAL_MS
        );
      }
      const pixels = displayDevicePixels();
      if (pixels >= UHD_4K_DEVICE_PIXELS) {
        return Math.max(baseInterval, HUGE_DISPLAY_FRAME_INTERVAL_MS);
      }
      if (pixels >= QHD_DEVICE_PIXELS) {
        return Math.max(baseInterval, LARGE_DISPLAY_FRAME_INTERVAL_MS);
      }
      return baseInterval;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      if (dt < frameIntervalMs()) {
        return;
      }
      last = now;
      paintFrame(dt);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (document.hidden || offscreen) {
        return;
      }
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => cancelAnimationFrame(raf);
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };
    const onBlur = () => {
      windowBlurred = true;
    };
    const onFocus = () => {
      windowBlurred = false;
    };

    const canvas = canvasRef.current;
    const observer =
      canvas && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            offscreen = entry ? !entry.isIntersecting : false;
            if (offscreen) {
              stop();
            } else {
              start();
            }
          })
        : null;
    if (canvas && observer) {
      observer.observe(canvas);
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    if (!document.hidden) {
      start();
    }
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      stop();
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
          transform: "scale(1.18)",
          mixBlendMode: isDark ? "screen" : undefined,
        }}
      />
    </div>
  );
});
