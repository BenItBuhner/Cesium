"use client";

interface HandoffDividerProps {
  fromAgent: string;
  toAgent: string;
}

function getAgentLabel(agentId: string): string {
  switch (agentId) {
    case "cursor-acp":
      return "Cursor";
    case "opencode-acp":
      return "OpenCode";
    case "codex-adapter":
      return "Codex";
    case "claude-adapter":
      return "Claude Code";
    default:
      return agentId;
  }
}

export function HandoffDivider({ fromAgent, toAgent }: HandoffDividerProps) {
  const fromLabel = getAgentLabel(fromAgent);
  const toLabel = getAgentLabel(toAgent);

  return (
    <div className="flex items-center gap-[12px] px-[16px] py-[8px]">
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
      <span className="text-[13px] text-[var(--text-secondary)] whitespace-nowrap">
        Agent handed off from {fromLabel} to {toLabel}
      </span>
      <div className="flex-1 h-px bg-[var(--border-subtle)]" />
    </div>
  );
}
