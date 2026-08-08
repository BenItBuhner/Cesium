"use client";

import { Cloud, type LucideProps } from "lucide-react";
import {
  INTEGRATION_ICON_FILES,
  normalizeIntegrationIconId,
  type IntegrationIconId,
} from "@/lib/integration-icons";
import { publicAssetUrl } from "@/lib/public-asset-url";

function LucideIntegrationFallback(props: LucideProps) {
  return <Cloud {...props} />;
}

type IntegrationIconProps = {
  providerId: string;
  className?: string;
  /** Lucide stroke width when using the fallback icon. */
  strokeWidth?: number;
  /**
   * When false, dims the icon slightly (e.g. inactive row).
   */
  emphasized?: boolean;
  /**
   * `"full"` (default) renders the original SVG. `"text"` paints the SVG as a
   * silhouette tinted with the parent `currentColor` (same pattern as
   * AgentBackendIcon).
   */
  tone?: "full" | "text";
};

/**
 * Theme-aware SVG marks from `/public/integration-icons/` for Cloud Agents
 * providers (GitHub, Linear, Slack) and manual dispatch (Cesium). Tracks
 * `html.dark` via dual `<img>` tags. Unknown ids fall back to Lucide `Cloud`.
 */
export function IntegrationIcon({
  providerId,
  className = "size-[14px] shrink-0",
  strokeWidth = 1.5,
  emphasized = true,
  tone = "full",
}: IntegrationIconProps) {
  const id: IntegrationIconId | null = normalizeIntegrationIconId(providerId);
  const files = id ? INTEGRATION_ICON_FILES[id] : null;

  if (!files) {
    return (
      <LucideIntegrationFallback
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

  const lightSrc = publicAssetUrl(
    `/integration-icons/${encodeURIComponent(files.light)}`
  );
  const darkSrc = publicAssetUrl(
    `/integration-icons/${encodeURIComponent(files.dark)}`
  );

  if (tone === "text") {
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
