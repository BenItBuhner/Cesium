"use client";

import Link from "next/link";
import { ArrowUp, ChevronDown, Plus, Sparkles } from "lucide-react";
import { agentContextLine } from "@/lib/agent-mock";
import { currentModel } from "@/lib/mock-data";

export function AgentMain() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-main)]">
      <div className="flex shrink-0 justify-center px-[16px] pt-[14px]">
        <p className="font-mono text-[12px] font-normal text-[var(--text-secondary)]">
          {agentContextLine}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center px-[20px] pb-[24px] pt-[min(15vh,120px)]">
        <div className="flex w-full max-w-[760px] flex-col items-stretch gap-[14px]">
          <div
            className="flex shrink-0 flex-col gap-[10px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]"
            data-agent-composer-shell
          >
            <div className="relative min-h-[120px]">
              <textarea
                readOnly
                rows={5}
                placeholder="Plan, build, @ to context"
                className="box-border min-h-[120px] w-full resize-none bg-transparent font-sans text-[14px] font-normal leading-normal text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                aria-label="Agent prompt"
              />
            </div>
            <div className="flex items-center justify-between gap-[10px]">
              <div className="flex min-w-0 items-center gap-[11px]">
                <button
                  type="button"
                  className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)]"
                  aria-label="Add context"
                >
                  <Plus className="size-[16px]" strokeWidth={1.5} aria-hidden />
                </button>
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-[4px] rounded-[var(--radius-tab)] py-[4px] pl-[2px] pr-[4px] transition-opacity hover:opacity-80"
                  aria-label="Model (demo)"
                >
                  <Sparkles className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
                  <span className="truncate font-sans text-[13px] font-normal text-[var(--text-secondary)]">
                    {currentModel.name}
                  </span>
                  <ChevronDown className="size-[8px] shrink-0 text-[var(--text-secondary)]" strokeWidth={2.5} aria-hidden />
                </button>
              </div>
              <button
                type="button"
                className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-dark)] transition-opacity hover:opacity-80"
                aria-label="Send"
              >
                <ArrowUp className="size-3 text-[var(--bg-main)]" strokeWidth={2.5} aria-hidden />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-[10px]">
            <button
              type="button"
              className="rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[7px] font-sans text-[12px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
            >
              Plan new idea{" "}
              <span className="text-[var(--text-secondary)]">(Cmd I)</span>
            </button>
            <Link
              href="/editor"
              className="rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[7px] font-sans text-[12px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
            >
              Open editor
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
