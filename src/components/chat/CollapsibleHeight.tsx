"use client";

import type { ReactNode } from "react";

/**
 * Expand/collapse with a fast, smooth height transition using CSS grid (0fr → 1fr).
 * Avoids max-height easing that feels sluggish on short content.
 */
export function CollapsibleHeight({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0 ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"} ${className ?? ""}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={`transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${open ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
