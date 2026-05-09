"use client";

import { Box, type LucideProps } from "lucide-react";
import type { ModelInfo } from "@/lib/types";
import {
  MODEL_BRAND_ICON_FILES,
  resolveModelBrandIcon,
} from "@/lib/model-brand-icons";

type ModelBrandIconProps = {
  model: ModelInfo;
  className?: string;
  strokeWidth?: number;
  emphasized?: boolean;
};

/**
 * Theme-aware brand marks from `/public/model-icons/` (dual `<img>` + `html.dark`),
 * with Auto / Efficiency / Performance → no icon; overlapping keywords → first
 * match in the name wins; unknown → Lucide `Box`.
 */
export function ModelBrandIcon({
  model,
  className = "size-[14px] shrink-0",
  strokeWidth = 1.5,
  emphasized = true,
}: ModelBrandIconProps) {
  const resolved = resolveModelBrandIcon(model);

  const lucideStyle: LucideProps["style"] =
    emphasized
      ? undefined
      : {
          opacity: 0.72,
        };

  if (resolved.kind === "none") {
    return null;
  }

  if (resolved.kind === "default") {
    return (
      <Box
        className={`${className} text-[var(--text-secondary)]`}
        strokeWidth={strokeWidth}
        style={lucideStyle}
        aria-hidden
      />
    );
  }

  const files = MODEL_BRAND_ICON_FILES[resolved.brand];
  const lightSrc = `/model-icons/${encodeURIComponent(files.light)}`;
  const darkSrc = `/model-icons/${encodeURIComponent(files.dark)}`;

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
