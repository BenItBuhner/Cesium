"use client";

import { Bot, Sparkles, type LucideProps } from "lucide-react";
import type { AgentBackendId } from "@/lib/agent-types";
import { AGENT_BACKEND_ICON_FILES } from "@/lib/agent-backend-icons";
import { publicAssetUrl } from "@/lib/public-asset-url";

function LucideBackendFallback({
  backendId,
  ...props
}: { backendId: AgentBackendId } & LucideProps) {
  if (
    backendId === "cesium-agent" ||
    backendId === "cursor-sdk" ||
    backendId === "codex-app-server"
  ) {
    return <Sparkles {...props} />;
  }
  return <Bot {...props} />;
}

type AgentBackendIconProps = {
  backendId: AgentBackendId;
  className?: string;
  /** Lucide stroke width when using fallback icons. */
  strokeWidth?: number;
  /**
   * When false, dims the icon slightly (e.g. inactive row in the menu).
   * Ignored for custom SVGs if you prefer uniform contrast; kept for fallback Lucide icons.
   */
  emphasized?: boolean;
  /**
   * `"full"` (default) renders the original multi-color SVG. `"text"` renders
   * the SVG silhouette tinted with the parent element's `currentColor`, so the
   * icon visually matches the surrounding text (used in the handoff divider
   * and other inline labels where a stark brand-color logo would stand out
   * against `var(--text-secondary)`).
   */
  tone?: "full" | "text";
};

/**
 * Renders theme-aware SVG marks from `/public/agent-backend-icons/` when present,
 * using `dark:hidden` / `dark:block` so it tracks `html.dark` (same as the app theme).
 * Falls back to Lucide icons for backends without assets (e.g. Gemini).
 */
export function AgentBackendIcon({
  backendId,
  className = "size-[13px] shrink-0",
  strokeWidth = 1.5,
  emphasized = true,
  tone = "full",
}: AgentBackendIconProps) {
  const files = AGENT_BACKEND_ICON_FILES[backendId];
  if (!files) {
    return (
      <LucideBackendFallback
        backendId={backendId}
        className={className}
        strokeWidth={strokeWidth}
        style={
          emphasized
            ? undefined
            : {
                opacity: 0.72,
              }
        }
      />
    );
  }

  const lightSrc = publicAssetUrl(`/agent-backend-icons/${encodeURIComponent(files.light)}`);
  const darkSrc = publicAssetUrl(`/agent-backend-icons/${encodeURIComponent(files.dark)}`);

  if (tone === "text") {
    // Paint the SVG as a mask filled with the parent's `currentColor` so the
    // mark inherits the surrounding text color (e.g. the handoff divider's
    // `var(--text-secondary)`). Only the alpha channel is read for the mask,
    // so using the "light" asset for both themes is intentional and fine.
    const maskUrl = `url("${lightSrc}")`;
    return (
      <span
        className={`inline-block shrink-0 ${className} ${
          emphasized ? "opacity-100" : "opacity-[0.72]"
        }`}
        style={{
          backgroundColor: "currentColor",
          WebkitMaskImage: maskUrl,
          maskImage: maskUrl,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
        aria-hidden
      />
    );
  }

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${className} ${
        emphasized ? "opacity-100" : "opacity-[0.72]"
      }`}
      aria-hidden
    >
      <img
        src={lightSrc}
        alt=""
        draggable={false}
        className="h-full w-full max-h-full max-w-full object-contain dark:hidden"
      />
      <img
        src={darkSrc}
        alt=""
        draggable={false}
        className="hidden h-full w-full max-h-full max-w-full object-contain dark:block"
      />
    </span>
  );
}
