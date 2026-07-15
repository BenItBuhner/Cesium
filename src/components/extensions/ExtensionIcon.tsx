"use client";

import {
  Blocks,
  Bot,
  CheckCircle2,
  Code2,
  FileCode2,
  Lightbulb,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { ExtensionIconDescriptor } from "@/lib/server-api";

const CODICON_FALLBACKS: Record<string, LucideIcon> = {
  beaker: Sparkles,
  bot: Bot,
  check: CheckCircle2,
  "check-all": CheckCircle2,
  "check-circle": CheckCircle2,
  code: Code2,
  file: FileCode2,
  gear: Settings,
  lightbulb: Lightbulb,
  robot: Bot,
  settings: Settings,
};

export function ExtensionIcon({
  icon,
  resourceUrl,
  label,
  className = "size-[18px]",
}: {
  icon?: ExtensionIconDescriptor | null;
  resourceUrl?: string;
  label: string;
  className?: string;
}) {
  if (icon?.kind === "codicon") {
    const Icon = CODICON_FALLBACKS[icon.name] ?? Blocks;
    return <Icon aria-hidden className={className} strokeWidth={1.8} />;
  }

  if (icon?.kind === "resource" && resourceUrl) {
    if (icon.render === "mask") {
      return (
        <span
          aria-hidden
          className={`${className} bg-current`}
          style={{
            maskImage: `url("${resourceUrl}")`,
            WebkitMaskImage: `url("${resourceUrl}")`,
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskSize: "contain",
            WebkitMaskSize: "contain",
          }}
        />
      );
    }
    return <img src={resourceUrl} alt="" className={`${className} object-contain`} draggable={false} />;
  }

  const fallback = icon?.kind === "fallback" ? icon.label : label.slice(0, 2);
  return (
    <span className="font-sans text-[11px] font-semibold uppercase leading-none" aria-hidden>
      {fallback}
    </span>
  );
}
