"use client";

import {
  AlertCircle,
  FileText,
  Plus,
  Plug,
  TerminalSquare,
  X,
} from "lucide-react";
import type { TerminalInfo } from "@/lib/types";
import type { PanelView } from "@/lib/workspace-session";
import { Terminal } from "./Terminal";

type PanelTabDefinition = {
  id: PanelView;
  label: string;
};

interface BottomPanelProps {
  activeView: PanelView;
  terminals: TerminalInfo[];
  activeTerminalId: string | null;
  onSelectView: (view: PanelView) => void;
  onSelectTerminal: (terminalId: string) => void;
  onCreateTerminal: () => void | Promise<void>;
  onCloseTerminal: (terminalId: string) => void | Promise<void>;
  onHidePanel: () => void;
}

const PANEL_TABS: PanelTabDefinition[] = [
  { id: "problems", label: "Problems" },
  { id: "output", label: "Output" },
  { id: "terminal", label: "Terminal" },
  { id: "ports", label: "Ports" },
];

const PROBLEM_SOURCES = [
  {
    source: "TypeScript",
    scope: "Language service",
    detail: "Type errors and warnings will land here once diagnostics are connected.",
  },
  {
    source: "ESLint",
    scope: "Linting",
    detail: "Lint problems will share this panel when the diagnostics feed is wired in.",
  },
  {
    source: "Tasks",
    scope: "Build output",
    detail: "Task failures and background build problems can surface here too.",
  },
] as const;

function getTerminalLabel(index: number): string {
  return `Terminal ${index + 1}`;
}

function getTerminalDetail(terminal: TerminalInfo): string {
  const shell = terminal.shell.split(/[\\/]/).at(-1) ?? terminal.shell;
  const cwd = terminal.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? terminal.cwd;
  return `${shell} • ${cwd}`;
}

function getPanelBadge(view: PanelView, terminalCount: number): string | null {
  switch (view) {
    case "problems":
      return "0";
    case "terminal":
      return String(terminalCount);
    case "ports":
      return "0";
    default:
      return null;
  }
}

export function BottomPanel({
  activeView,
  terminals,
  activeTerminalId,
  onSelectView,
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
  const showTerminalActions = activeView === "terminal";
  const showPortAction = activeView === "ports";

  const terminalView = (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-main)]">
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2">
        <div className="hide-scrollbar-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {terminals.length === 0 ? (
            <div className="flex items-center gap-2 px-2 font-sans text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              <TerminalSquare className="size-[13px]" strokeWidth={1.5} aria-hidden />
              <span>No terminals</span>
            </div>
          ) : (
            terminals.map((terminal, index) => {
              const isActive = terminal.id === resolvedActiveTerminalId;
              return (
                <button
                  key={terminal.id}
                  type="button"
                  onClick={() => onSelectTerminal(terminal.id)}
                  className={`group flex max-w-[260px] shrink-0 items-center gap-2 rounded-[var(--radius-tab)] border px-3 py-1.5 text-left transition-colors ${
                    isActive
                      ? "border-[var(--border-card)] bg-[var(--bg-tab-active)]"
                      : "border-transparent bg-[var(--bg-tab-inactive)] hover:bg-white/[0.03]"
                  }`}
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
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onCloseTerminal(terminal.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        void onCloseTerminal(terminal.id);
                      }
                    }}
                    className="flex size-[22px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] opacity-0 transition-opacity hover:bg-white/[0.04] hover:text-[var(--text-primary)] group-hover:opacity-100"
                    aria-label={`Close ${getTerminalLabel(index)}`}
                  >
                    <X className="size-[13px]" strokeWidth={1.5} aria-hidden />
                  </span>
                </button>
              );
            })
          )}
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

  const problemsView = (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-main)]">
      <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3">
        <span className="rounded-full border border-[var(--border-card)] px-2 py-0.5 font-sans text-[11px] text-[var(--text-primary)]">
          0 Errors
        </span>
        <span className="rounded-full border border-[var(--border-card)] px-2 py-0.5 font-sans text-[11px] text-[var(--text-primary)]">
          0 Warnings
        </span>
        <span className="rounded-full border border-[var(--border-card)] px-2 py-0.5 font-sans text-[11px] text-[var(--text-secondary)]">
          0 Infos
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
          <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,2fr)] gap-3 border-b border-[var(--border-subtle)] px-3 py-2 font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            <span>Source</span>
            <span>Status</span>
            <span>Details</span>
          </div>
          {PROBLEM_SOURCES.map((item) => (
            <div
              key={item.source}
              className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,2fr)] gap-3 border-b border-[var(--border-subtle)] px-3 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <AlertCircle
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <span className="truncate font-sans text-[12px] text-[var(--text-primary)]">
                    {item.source}
                  </span>
                </div>
                <p className="mt-1 font-sans text-[11px] text-[var(--text-secondary)]">
                  {item.scope}
                </p>
              </div>
              <div className="min-w-0">
                <span className="inline-flex rounded-full border border-[var(--border-card)] px-2 py-0.5 font-sans text-[11px] text-[var(--text-secondary)]">
                  Placeholder
                </span>
              </div>
              <p className="min-w-0 font-sans text-[12px] leading-5 text-[var(--text-secondary)]">
                {item.detail}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 font-sans text-[11px] text-[var(--text-secondary)]">
          This Problems view is intentionally scaffolded to match the VS Code panel layout while
          TypeScript and ESLint diagnostics are being wired in.
        </p>
      </div>
    </div>
  );

  const outputView = (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-main)]">
      <div className="flex h-[36px] shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3">
        <div className="flex items-center gap-2">
          <FileText className="size-[14px] text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
          <span className="font-sans text-[12px] text-[var(--text-primary)]">OpenCursor</span>
        </div>
        <span className="font-sans text-[11px] text-[var(--text-secondary)]">
          Placeholder channel
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-6 text-[var(--text-secondary)]">
{`[placeholder] Output channels will appear here.
[placeholder] Task logs, extension output, and language-service streams can share this surface.
[placeholder] The panel scaffold now matches the VS Code-style multi-view layout.`}
        </pre>
      </div>
    </div>
  );

  const portsView = (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-main)]">
      <div className="flex h-[36px] shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3">
        <span className="font-sans text-[12px] text-[var(--text-primary)]">
          Forwarded Ports
        </span>
        <span className="font-sans text-[11px] text-[var(--text-secondary)]">
          0 active
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
          <div className="grid grid-cols-[84px_minmax(0,1.4fr)_110px_110px] gap-3 border-b border-[var(--border-subtle)] px-3 py-2 font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            <span>Port</span>
            <span>Local address</span>
            <span>Visibility</span>
            <span>Preview</span>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
            <Plug className="size-[18px] text-[var(--text-secondary)]" strokeWidth={1.5} aria-hidden />
            <div className="space-y-1">
              <p className="font-sans text-[13px] text-[var(--text-primary)]">
                No forwarded ports yet.
              </p>
              <p className="font-sans text-[12px] text-[var(--text-secondary)]">
                Running services and forwarded previews will appear here once port forwarding is wired
                in.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const activeViewContent =
    activeView === "terminal"
      ? terminalView
      : activeView === "problems"
        ? problemsView
        : activeView === "ports"
          ? portsView
          : outputView;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-panel)]">
      <div className="flex h-[35px] shrink-0 items-end gap-2 border-b border-[var(--border-subtle)] px-2">
        <div className="hide-scrollbar-x flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {PANEL_TABS.map((tab) => {
            const badge = getPanelBadge(tab.id, terminals.length);
            const isActive = tab.id === activeView;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectView(tab.id)}
                className={`inline-flex h-[31px] shrink-0 items-center gap-2 border-b-2 px-2.5 font-sans text-[11px] font-medium uppercase tracking-[0.08em] transition-colors ${
                  isActive
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
                aria-pressed={isActive}
              >
                <span>{tab.label}</span>
                {badge ? (
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-sans text-[10px] normal-case tracking-normal ${
                      isActive
                        ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                        : "bg-white/[0.04] text-[var(--text-secondary)]"
                    }`}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1 pb-[3px]">
          {showTerminalActions ? (
            <button
              type="button"
              onClick={() => void onCreateTerminal()}
              className="flex h-[26px] items-center justify-center rounded-[var(--radius-tab)] px-2 text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
              aria-label="Create new terminal"
              title="New Terminal"
            >
              <Plus className="size-[15px]" strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          {showPortAction ? (
            <button
              type="button"
              disabled
              className="rounded-[var(--radius-tab)] border border-[var(--border-card)] px-2 py-1 font-sans text-[11px] text-[var(--text-secondary)] opacity-60"
              title="Port forwarding is still a placeholder"
            >
              Forward a Port
            </button>
          ) : null}
          <button
            type="button"
            onClick={onHidePanel}
            className="flex h-[26px] items-center justify-center rounded-[var(--radius-tab)] px-2 text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
            aria-label="Hide panel"
            title="Hide Panel"
          >
            <X className="size-[15px]" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{activeViewContent}</div>
    </div>
  );
}
