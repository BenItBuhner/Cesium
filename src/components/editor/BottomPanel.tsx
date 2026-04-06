"use client";

import { Plus, TerminalSquare, X } from "lucide-react";
import type { TerminalInfo } from "@/lib/types";
import { Terminal } from "./Terminal";

interface BottomPanelProps {
  terminals: TerminalInfo[];
  activeTerminalId: string | null;
  onSelectTerminal: (terminalId: string) => void;
  onCreateTerminal: () => void | Promise<void>;
  onCloseTerminal: (terminalId: string) => void | Promise<void>;
  onHidePanel: () => void;
}

function getTerminalLabel(index: number): string {
  return `Terminal ${index + 1}`;
}

function getTerminalDetail(terminal: TerminalInfo): string {
  const shell = terminal.shell.split(/[\\/]/).at(-1) ?? terminal.shell;
  const cwd = terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? terminal.cwd;
  return `${shell} • ${cwd}`;
}

export function BottomPanel({
  terminals,
  activeTerminalId,
  onSelectTerminal,
  onCreateTerminal,
  onCloseTerminal,
  onHidePanel,
}: BottomPanelProps) {
  const resolvedActiveTerminalId =
    (activeTerminalId && terminals.some((terminal) => terminal.id === activeTerminalId)
      ? activeTerminalId
      : null) ?? terminals[0]?.id ?? null;
  const activeTerminal =
    terminals.find((terminal) => terminal.id === resolvedActiveTerminalId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--border-subtle)] bg-[var(--bg-main)]">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2">
        <div className="hide-scrollbar-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {terminals.length === 0 ? (
            <div className="flex items-center gap-2 px-2 font-sans text-[12px] text-[var(--text-secondary)]">
              <TerminalSquare className="size-[14px]" strokeWidth={1.5} aria-hidden />
              <span>Terminal</span>
            </div>
          ) : (
            terminals.map((terminal, index) => {
              const isActive = terminal.id === resolvedActiveTerminalId;
              return (
                <div
                  key={terminal.id}
                  className={`group flex max-w-[260px] shrink-0 items-center overflow-hidden rounded-[var(--radius-tab)] border ${
                    isActive
                      ? "border-[var(--border-card)] bg-[var(--bg-tab-active)]"
                      : "border-transparent bg-[var(--bg-tab-inactive)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectTerminal(terminal.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                    title={terminal.cwd}
                  >
                    <TerminalSquare
                      className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-[12px] text-[var(--text-primary)]">
                        {getTerminalLabel(index)}
                      </span>
                      <span className="block truncate font-sans text-[11px] text-[var(--text-secondary)]">
                        {getTerminalDetail(terminal)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onCloseTerminal(terminal.id)}
                    className="mr-1 flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                    aria-label={`Close ${getTerminalLabel(index)}`}
                    title="Close terminal"
                  >
                    <X className="size-[14px]" strokeWidth={1.5} aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void onCreateTerminal()}
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
            aria-label="Create new terminal"
            title="New Terminal"
          >
            <Plus className="size-[16px]" strokeWidth={1.5} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onHidePanel}
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
            aria-label="Hide panel"
            title="Hide Panel"
          >
            <X className="size-[16px]" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTerminal ? (
          <Terminal terminalId={activeTerminal.id} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="space-y-1">
              <p className="font-sans text-[13px] text-[var(--text-primary)]">
                No terminals are running in this workspace.
              </p>
              <p className="font-sans text-[12px] text-[var(--text-secondary)]">
                Create one to use the dedicated bottom panel.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void onCreateTerminal()}
              className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-1.5 font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.04]"
            >
              New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
