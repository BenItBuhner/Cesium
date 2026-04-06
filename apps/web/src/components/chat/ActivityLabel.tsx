"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CollapsibleHeight } from "./CollapsibleHeight";

interface ActivityLabelProps {
  label: string;
  detail?: string;
  files?: string[];
  defaultOpen?: boolean;
}

export function ActivityLabel({
  label,
  detail,
  files,
  defaultOpen = false,
}: ActivityLabelProps) {
  const expandable = Boolean(
    (detail && detail.trim()) || (files && files.length > 0)
  );
  const [open, setOpen] = useState(expandable && defaultOpen);

  return (
    <div className="min-w-0 px-[1px]">
      {expandable ? (
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
      ) : (
        <p className="font-sans text-[13px] font-normal leading-snug text-[var(--text-secondary)]">
          {label}
        </p>
      )}

      <CollapsibleHeight open={expandable && open}>
        <div className="pt-[8px]">
          <div className="ml-[2px] border-l border-[var(--border-subtle)] pl-[10px]">
            {detail?.trim() ? (
              <p className="font-sans text-[13px] font-normal leading-normal text-[var(--text-primary)]">
                {detail}
              </p>
            ) : null}
            {files && files.length > 0 ? (
              <ul
                className={`mt-[6px] flex list-none flex-col gap-[4px] ${
                  detail?.trim() ? "" : ""
                }`}
              >
                {files.map((path) => (
                  <li
                    key={path}
                    className="font-mono text-[12px] font-normal leading-snug text-[var(--text-secondary)]"
                  >
                    {path}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </CollapsibleHeight>
    </div>
  );
}
