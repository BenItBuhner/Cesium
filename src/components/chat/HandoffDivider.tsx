"use client";

import type { AgentBackendId } from "@/lib/agent-types";
import { AgentBackendIcon } from "./AgentBackendIcon";

interface HandoffDividerProps {
  fromAgent: string;
  toAgent: string;
}

export function getAgentLabel(agentId: string): string {
  switch (agentId) {
    case "cesium-agent":
      return "Cesium Agent";
    case "cursor-acp":
      return "Cursor";
    case "cursor-sdk":
      return "Cursor SDK";
    case "opencode-acp":
      return "OpenCode";
    case "opencode-server":
      return "OpenCode Server";
    case "opencode-v2-beta":
      return "OpenCode v2 Beta";
    case "gemini-acp":
      return "Gemini (retired)";
    case "devin-acp":
      return "Devin";
    case "codex-adapter":
      return "Codex";
    case "codex-app-server":
      return "Codex App Server";
    case "claude-code-sdk":
      return "Claude Code";
    case "pi-agent":
      return "Pi Agent";
    case "google-antigravity-cli":
      return "Google Antigravity";
    default:
      return agentId;
  }
}

function parseHandoffBackendId(raw: string): AgentBackendId | null {
  if (raw === "claude-adapter") {
    return "claude-code-sdk";
  }
  switch (raw) {
    case "cesium-agent":
    case "cursor-sdk":
    case "opencode-server":
    case "opencode-v2-beta":
    case "devin-acp":
    case "codex-app-server":
    case "claude-code-sdk":
    case "pi-agent":
    case "google-antigravity-cli":
      return raw;
    case "cursor-acp":
      return "cursor-sdk";
    case "opencode-acp":
      return "opencode-server";
    case "codex-adapter":
      return "codex-app-server";
    case "gemini-acp":
      return "google-antigravity-cli";
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
