"use client";

import { SquareTerminal } from "lucide-react";
import { useTheme } from "@/components/theme/ThemeProvider";

interface ShellCommandCardProps {
  title: string;
}

export function ShellCommandCard({ title }: ShellCommandCardProps) {
  const { themeConfig } = useTheme();
  return (
    <div className="flex items-start gap-[8px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[8px]">
      {themeConfig.showToolCallIcons ? (
        <SquareTerminal
          className="mt-[2px] size-[14px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 flex-1 font-sans text-[13px] font-normal leading-snug text-[var(--text-primary)]">
        {title}
      </span>
    </div>
  );
}
