"use client";

import type { AgentBackendId } from "@/lib/agent-types";
import { AgentBackendIcon } from "./AgentBackendIcon";

interface HandoffDividerProps {
  fromAgent: string;
  toAgent: string;
}

export function getAgentLabel(agentId: string): string {
  switch (agentId) {
    case "cursor-acp":
      return "Cursor";
    case "opencode-acp":
      return "OpenCode";
    case "gemini-acp":
      return "Gemini";
    case "codex-adapter":
      return "Codex";
    case "claude-adapter":
      return "Claude Code";
    default:
      return agentId;
  }
}

function parseHandoffBackendId(raw: string): AgentBackendId | null {
  switch (raw) {
    case "cursor-acp":
    case "opencode-acp":
    case "gemini-acp":
    case "codex-adapter":
    case "claude-adapter":
      return raw;
    default:
      return null;
  }
}

const HANDOFF_ICON_CLASS = "size-[13px] shrink-0";

export function HandoffAgentMark({
  backendIdRaw,
  label,
}: {
  backendIdRaw: string;
  label: string;
}) {
  const id = parseHandoffBackendId(backendIdRaw);
  return (
    <span className="inline-flex items-center gap-[5px]">
      {id ? (
        // `tone="text"` renders the SVG as a mask filled with the parent span's
        // `currentColor` (`var(--text-secondary)` here) so the logo matches the
        // divider text instead of standing out in its brand color.
        <AgentBackendIcon
          backendId={id}
          className={HANDOFF_ICON_CLASS}
          tone="text"
        />
      ) : null}
      <span>{label}</span>
    </span>
  );
}

export function HandoffDivider({ fromAgent, toAgent }: HandoffDividerProps) {
  const fromLabel = getAgentLabel(fromAgent);
  const toLabel = getAgentLabel(toAgent);

  return (
    <div className="flex items-center gap-[12px] px-[16px] py-[8px]">
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
      <span className="inline-flex items-center gap-[6px] whitespace-nowrap text-[13px] text-[var(--text-secondary)]">
        <span>Agent handed off from</span>
        <HandoffAgentMark backendIdRaw={fromAgent} label={fromLabel} />
        <span>to</span>
        <HandoffAgentMark backendIdRaw={toAgent} label={toLabel} />
      </span>
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
    </div>
  );
}
