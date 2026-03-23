"use client";

import { useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  ScrollText,
  Lightbulb,
  Wrench,
  SquareTerminal,
} from "lucide-react";
import { CollapsibleHeight } from "./CollapsibleHeight";
import type { WorkedSessionEntry } from "@/lib/types";

const iconWrap =
  "mt-[2px] flex size-[14px] shrink-0 items-center justify-center text-[var(--text-secondary)]";

interface WorkedSessionCardProps {
  label: string;
  entries: WorkedSessionEntry[];
  defaultOpen?: boolean;
}

export function WorkedSessionCard({
  label,
  entries,
  defaultOpen = false,
}: WorkedSessionCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="min-w-0 px-[1px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-center gap-[6px] text-left text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        <span className="font-sans text-[13px] font-normal leading-snug">
          {label}
        </span>
        <ChevronDown
          className={`size-[14px] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      <CollapsibleHeight open={open}>
        <div className="pt-[10px]">
          <div className="ml-[2px] flex flex-col gap-[14px] border-l border-[var(--border-subtle)] pl-[10px]">
            {entries.map((entry, i) => (
              <WorkedEntryBlock key={i} entry={entry} />
            ))}
          </div>
        </div>
      </CollapsibleHeight>
    </div>
  );
}

function WorkedEntryBlock({ entry }: { entry: WorkedSessionEntry }) {
  switch (entry.kind) {
    case "verbatim":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <ScrollText className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <pre className="whitespace-pre-wrap font-mono text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
            {entry.text}
          </pre>
        </div>
      );
    case "explore":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <FolderOpen className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
              {entry.caption ?? `Explored ${entry.paths.length} file${entry.paths.length === 1 ? "" : "s"}`}
            </p>
            <ul className="mt-[6px] flex list-none flex-col gap-[4px]">
              {entry.paths.map((path) => (
                <li
                  key={path}
                  className="font-mono text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                >
                  {path}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    case "reasoning":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            <Lightbulb className="size-[14px]" strokeWidth={1.5} aria-hidden />
          </span>
          <p className="font-sans text-[13px] font-normal leading-relaxed text-[var(--text-primary)]">
            {entry.text}
          </p>
        </div>
      );
    case "tool":
      return (
        <div className="flex gap-[8px]">
          <span className={iconWrap}>
            {entry.variant === "terminal" ? (
              <SquareTerminal className="size-[14px]" strokeWidth={1.5} aria-hidden />
            ) : (
              <Wrench className="size-[14px]" strokeWidth={1.5} aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-[13px] font-normal text-[var(--text-primary)]">
              {entry.title}
            </p>
            {entry.detail?.trim() ? (
              <p className="mt-[4px] font-sans text-[12px] font-normal leading-relaxed text-[var(--text-secondary)]">
                {entry.detail}
              </p>
            ) : null}
          </div>
        </div>
      );
  }
}
