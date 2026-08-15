"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  type AuroraConversationState,
  resolveAuroraPresetColors,
} from "@/lib/aurora-config";
import "./aurora.css";

const STATE_DURATION_MULT: Record<AuroraConversationState, number> = {
  new: 1,
  idle: 1.08,
  typing: 0.78,
  working: 0.5,
  awaiting: 1.12,
  completed: 0.86,
  failed: 1.42,
  paused: 2.35,
  cancelled: 1.65,
};

const STATE_OPACITY_MULT: Record<AuroraConversationState, number> = {
  new: 1.08,
  idle: 0.88,
  typing: 1.06,
  working: 1.28,
  awaiting: 1.02,
  completed: 1.2,
  failed: 0.82,
  paused: 0.68,
  cancelled: 0.56,
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

export function AuroraBackground({
  state,
  className = "",
  preview = false,
}: {
  state: AuroraConversationState;
  className?: string;
  preview?: boolean;
}) {
  const { themeConfig } = useTheme();
  const aurora = themeConfig.aurora;
  const [pageHidden, setPageHidden] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const syncDark = () => setIsDark(root.classList.contains("dark"));
    syncDark();
    const observer = new MutationObserver(syncDark);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches || prefersReducedMotion());
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setPageHidden(document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const visualState = aurora.reactToState || preview ? state : "idle";
  const colors = useMemo(
    () => resolveAuroraPresetColors(aurora, isDark),
    [aurora, isDark]
  );

  if (!aurora.enabled && !preview) {
    return null;
  }

  const intensity = aurora.intensity / 100;
  const speed = aurora.speed / 100;
  const blur = 36 + (aurora.blur / 100) * 96;
  const baseOpacity = (isDark ? 0.34 : 0.26) * (0.55 + intensity * 1.05);
  const opacity = baseOpacity * STATE_OPACITY_MULT[visualState];
  const durationSec = (16 + (1 - speed) * 36) * STATE_DURATION_MULT[visualState];

  const style = {
    "--aurora-color-a": colors[0].join(", "),
    "--aurora-color-b": colors[1].join(", "),
    "--aurora-color-c": colors[2].join(", "),
    "--aurora-opacity": opacity.toFixed(3),
    "--aurora-opacity-base": opacity.toFixed(3),
    "--aurora-blur": `${Math.round(blur)}px`,
    "--aurora-duration": `${durationSec.toFixed(2)}s`,
    "--aurora-duration-base": `${durationSec.toFixed(2)}s`,
    "--aurora-amp": visualState === "working" ? "1.28" : visualState === "paused" ? "0.42" : "1",
  } as CSSProperties;

  return (
    <div
      className={`aurora-root ${className}`.trim()}
      data-state={visualState}
      data-preview={preview ? "true" : "false"}
      data-paused={pageHidden || reduceMotion ? "true" : "false"}
      aria-hidden
      style={style}
    >
      <div className="aurora-stage">
        <div className="aurora-wash" />
        <div className="aurora-blob aurora-blob-a" />
        <div className="aurora-blob aurora-blob-b" />
        <div className="aurora-blob aurora-blob-c" />
        <div className="aurora-ribbon aurora-ribbon-a" />
        <div className="aurora-ribbon aurora-ribbon-b" />
        <div className="aurora-tint" />
        <div className="aurora-typing" />
        <div
          key={visualState === "completed" ? "bloom-on" : "bloom-off"}
          className="aurora-bloom"
        />
      </div>
    </div>
  );
}
