"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useOptionalAgentConversations } from "@/components/chat/AgentConversationsContext";
import {
  ContextUsageBar,
  contextColor,
  type ContextUsageBarSegment,
} from "@/components/chat/ContextUsageBar";
import { useContextUsageViewMode } from "@/components/chat/ContextBreakdownDock";
import { ContextUsageRing } from "@/components/chat/ContextUsageRing";
import type {
  AgentContextSegmentKind,
  AgentContextTranscript,
  AgentContextTranscriptEntry,
  AgentContextTranscriptToolCall,
  AgentContextUsageCategoryId,
  AgentToolEditPreview,
} from "@/lib/agent-types";
import {
  formatContextTokenCount,
  formatContextUsagePair,
} from "@/lib/composer-status-bar";
import {
  condenseContextTimeline,
  contextTimelineCondenseThreshold,
} from "@/lib/context-usage-timeline";
import { fetchAgentContextTranscript } from "@/lib/server-api";

const REFRESH_DEBOUNCE_MS = 1_200;
const CLIP_CHARS = 6_000;
const CATEGORY_ORDER: AgentContextUsageCategoryId[] = [
  "system_prompt",
  "tool_definitions",
  "mcp",
  "summarized_conversation",
  "conversation",
];

const KIND_BADGE: Record<AgentContextSegmentKind, string> = {
  system_prompt: "System prompt",
  tool_definitions: "Tool definitions",
  mcp_definitions: "MCP section",
  user_message: "User",
  system_reminder: "Reminder",
  assistant_message: "Assistant",
  reasoning: "Reasoning",
  tool_call: "Tool call",
  plan: "Plan",
  compaction_summary: "Compaction",
  agent_handoff: "Handoff",
  chat_fork: "Fork",
};

function formatClock(epochMs: number | undefined): string {
  if (!epochMs) {
    return "";
  }
  try {
    return new Date(epochMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function countLines(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const monoBlock =
  "whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[10px] py-[8px] font-mono text-[11.5px] leading-[17px] text-[var(--text-primary)]";

/**
 * Verbatim text. Nothing is condensed: long bodies are clipped for the DOM's
 * sake behind an explicit "show everything" toggle that reveals every byte.
 */
function VerbatimText({
  text,
  className = "",
  tone = "default",
}: {
  text: string;
  className?: string;
  tone?: "default" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const clipped = !expanded && text.length > CLIP_CHARS;
  const shown = clipped ? text.slice(0, CLIP_CHARS) : text;
  const toneClass = tone === "error" ? "text-[var(--status-error)]" : "";
  return (
    <div className={className}>
      <pre className={`${monoBlock} ${toneClass}`}>{shown || " "}</pre>
      {text.length > CLIP_CHARS ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-[4px] font-sans text-[11px] text-[var(--accent)] hover:underline"
        >
          {clipped
            ? `Show everything (${countLines(text).toLocaleString()} lines · ${text.length.toLocaleString()} chars)`
            : "Collapse to the first 6,000 characters"}
        </button>
      ) : null}
    </div>
  );
}

function Disclosure({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[6px] border border-[var(--border-subtle)]">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-[6px] px-[8px] py-[6px] text-left font-sans text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
      >
        {open ? (
          <ChevronDown className="size-[12px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight className="size-[12px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta ? (
          <span className="shrink-0 font-sans text-[10.5px] tabular-nums text-[var(--text-secondary)]">
            {meta}
          </span>
        ) : null}
      </button>
      {open ? <div className="border-t border-[var(--border-subtle)] px-[8px] py-[8px]">{children}</div> : null}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-[4px] font-sans text-[10.5px] font-medium uppercase tracking-[0.04em] text-[var(--text-secondary)]">
      {children}
    </p>
  );
}

function ArgumentsTable({ args, omit = [] }: { args: Record<string, unknown>; omit?: string[] }) {
  const entries = Object.entries(args).filter(([key]) => !omit.includes(key));
  if (entries.length === 0) {
    return null;
  }
  return (
    <dl className="grid grid-cols-[minmax(80px,max-content)_1fr] gap-x-[12px] gap-y-[6px]">
      {entries.map(([key, value]) => {
        const scalar =
          value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
        const text = typeof value === "string" ? value : scalar ? String(value) : prettyJson(value);
        const multiline = text.includes("\n") || text.length > 120;
        return (
          <div key={key} className="contents">
            <dt className="pt-[2px] font-mono text-[11px] text-[var(--text-secondary)]">{key}</dt>
            <dd className="min-w-0">
              {multiline || !scalar ? (
                <VerbatimText text={text} />
              ) : (
                <code className="break-all font-mono text-[11.5px] text-[var(--text-primary)]">
                  {text || '""'}
                </code>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function EditPreviewBlock({ preview }: { preview: AgentToolEditPreview }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-[8px] border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[8px] py-[4px] font-mono text-[11px]">
        <span className="truncate text-[var(--text-primary)]">{preview.path ?? "edit"}</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-[#3fb950]">+{preview.addedLines}</span>{" "}
          <span className="text-[#f85149]">−{preview.removedLines}</span>
        </span>
      </div>
      <pre className="max-h-[480px] overflow-auto font-mono text-[11px] leading-[17px]">
        {preview.lines.map((line, index) => {
          const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "gap" ? "…" : " ";
          const rowClass =
            line.kind === "add"
              ? "bg-[color-mix(in_srgb,#3fb950_14%,transparent)] text-[var(--text-primary)]"
              : line.kind === "remove"
                ? "bg-[color-mix(in_srgb,#f85149_14%,transparent)] text-[var(--text-primary)]"
                : line.kind === "gap"
                  ? "text-[var(--text-disabled)]"
                  : "text-[var(--text-secondary)]";
          return (
            <div key={index} className={`flex gap-[8px] px-[8px] ${rowClass}`}>
              <span className="w-[34px] shrink-0 select-none text-right tabular-nums text-[var(--text-disabled)]">
                {line.oldLineNumber ?? ""}
              </span>
              <span className="w-[34px] shrink-0 select-none text-right tabular-nums text-[var(--text-disabled)]">
                {line.newLineNumber ?? ""}
              </span>
              <span className="w-[10px] shrink-0 select-none">{marker}</span>
              <span className="whitespace-pre-wrap break-all">{line.text}</span>
            </div>
          );
        })}
      </pre>
      {preview.truncated ? (
        <p className="border-t border-[var(--border-subtle)] px-[8px] py-[4px] font-sans text-[10.5px] text-[var(--text-disabled)]">
          The harness truncated this preview; the full result is in the tool output below.
        </p>
      ) : null}
    </div>
  );
}

function statusChipClass(status: AgentContextTranscriptToolCall["status"]): string {
  switch (status) {
    case "completed":
      return "border-[color-mix(in_srgb,var(--status-success)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)] text-[var(--status-success)]";
    case "failed":
      return "border-[color-mix(in_srgb,var(--status-error)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] text-[var(--status-error)]";
    case "cancelled":
      return "border-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)] text-[var(--status-warning)]";
    case "in_progress":
      return "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]";
    default:
      return "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)]";
  }
}

/** Tool invocation rendered the way a human reads it, not as a JSON blob. */
function ToolCallBody({ call }: { call: AgentContextTranscriptToolCall }) {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : null;
  const argText = typeof call.arguments === "string" ? call.arguments : null;
  const str = (key: string): string | null => {
    const value = args?.[key];
    return typeof value === "string" ? value : null;
  };
  const shellLike = call.toolKind === "terminal" || call.name === "terminal";
  const command = shellLike ? str("command") ?? str("cmd") : null;
  const pathArg = str("path") ?? str("file") ?? str("file_path");
  const isMcp = call.name === "call_mcp_tool";
  const mcpArgs = isMcp ? args?.arguments ?? args?.args ?? null : null;
  const isEdit = call.toolKind === "edit" || call.name === "edit_file" || call.name === "write_file";

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex flex-wrap items-center gap-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
        <code className="rounded-[4px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-mono text-[11px] text-[var(--text-primary)]">
          {call.name}
        </code>
        <span
          className={`inline-flex items-center rounded-full border px-[7px] py-[1px] text-[10.5px] font-medium ${statusChipClass(call.status)}`}
        >
          {call.status.replace("_", " ")}
        </span>
        {call.pluginName ? <span>via {call.pluginName}</span> : null}
        <code className="ml-auto font-mono text-[10.5px] text-[var(--text-disabled)]">{call.toolCallId}</code>
      </div>

      {command != null ? (
        <div>
          <SectionLabel>Command</SectionLabel>
          <pre className={`${monoBlock} text-[var(--text-primary)]`}>
            <span className="select-none text-[var(--text-disabled)]">$ </span>
            {command}
          </pre>
          {args ? <div className="mt-[8px]"><ArgumentsTable args={args} omit={["command", "cmd"]} /></div> : null}
        </div>
      ) : isMcp && args ? (
        <div>
          <SectionLabel>MCP call</SectionLabel>
          <p className="mb-[6px] font-mono text-[11.5px] text-[var(--text-primary)]">
            {str("serverId") ?? str("server") ?? "?"} <span className="text-[var(--text-disabled)]">/</span>{" "}
            {str("toolName") ?? str("tool") ?? "?"}
          </p>
          {mcpArgs != null ? (
            <VerbatimText text={typeof mcpArgs === "string" ? mcpArgs : prettyJson(mcpArgs)} />
          ) : null}
          <div className="mt-[8px]">
            <ArgumentsTable
              args={args}
              omit={["serverId", "server", "toolName", "tool", "arguments", "args"]}
            />
          </div>
        </div>
      ) : args ? (
        <div>
          <SectionLabel>{pathArg ? "Target" : "Arguments"}</SectionLabel>
          {pathArg ? (
            <p className="mb-[6px] font-mono text-[11.5px] text-[var(--text-primary)]">{pathArg}</p>
          ) : null}
          <ArgumentsTable
            args={args}
            omit={[
              ...(pathArg ? ["path", "file", "file_path"] : []),
              ...(isEdit && call.editPreview ? ["old_string", "new_string", "content", "edits", "patch"] : []),
            ]}
          />
        </div>
      ) : argText ? (
        <div>
          <SectionLabel>Arguments</SectionLabel>
          <VerbatimText text={argText} />
        </div>
      ) : null}

      {call.editPreview ? (
        <div>
          <SectionLabel>Edit</SectionLabel>
          <EditPreviewBlock preview={call.editPreview} />
        </div>
      ) : null}

      {call.locations && call.locations.length > 0 && !pathArg ? (
        <div>
          <SectionLabel>Locations</SectionLabel>
          <ul className="list-none font-mono text-[11.5px] text-[var(--text-primary)]">
            {call.locations.map((location, index) => (
              <li key={`${location.path}:${index}`}>
                {location.path}
                {location.line != null ? `:${location.line}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <SectionLabel>{shellLike ? "Output" : "Result"} · sent to the model verbatim</SectionLabel>
        {call.result != null ? (
          <VerbatimText text={call.result} tone={call.status === "failed" ? "error" : "default"} />
        ) : (
          <p className="font-sans text-[11.5px] italic text-[var(--text-disabled)]">
            No result yet - the call has not completed.
          </p>
        )}
      </div>
    </div>
  );
}

function ToolDefinitionsBody({ tools }: { tools: NonNullable<AgentContextTranscriptEntry["tools"]> }) {
  const [filter, setFilter] = useState("");
  const shown = filter.trim()
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
          tool.description.toLowerCase().includes(filter.trim().toLowerCase())
      )
    : tools;
  return (
    <div className="flex flex-col gap-[6px]">
      <label className="flex items-center gap-[6px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[8px] py-[4px]">
        <Search className="size-[12px] text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${tools.length} tool schemas`}
          className="min-w-0 flex-1 bg-transparent font-sans text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
        />
      </label>
      {shown.map((tool) => {
        const schema = prettyJson(tool.parameters);
        return (
          <Disclosure
            key={tool.name}
            title={<code className="font-mono text-[11.5px]">{tool.name}</code>}
            meta={`~${formatContextTokenCount(Math.ceil((tool.name.length + tool.description.length + schema.length) / 4))}`}
          >
            <SectionLabel>Description</SectionLabel>
            <VerbatimText text={tool.description} className="mb-[8px]" />
            <SectionLabel>Parameters (JSON Schema)</SectionLabel>
            <VerbatimText text={schema} />
          </Disclosure>
        );
      })}
      {shown.length === 0 ? (
        <p className="font-sans text-[11.5px] text-[var(--text-disabled)]">No tool matches that filter.</p>
      ) : null}
    </div>
  );
}

function EntryBody({ entry, raw }: { entry: AgentContextTranscriptEntry; raw: boolean }) {
  if (raw) {
    const payload =
      entry.events && entry.events.length > 0
        ? entry.events
        : entry.tools
          ? entry.tools
          : { text: entry.text ?? "" };
    return (
      <div>
        <SectionLabel>
          {entry.events && entry.events.length > 0 ? "Stored events (raw trace)" : "Raw payload"}
        </SectionLabel>
        <VerbatimText text={prettyJson(payload)} />
      </div>
    );
  }
  switch (entry.kind) {
    case "tool_call":
      return entry.toolCall ? <ToolCallBody call={entry.toolCall} /> : null;
    case "tool_definitions":
      return entry.tools ? <ToolDefinitionsBody tools={entry.tools} /> : <VerbatimText text={entry.text ?? ""} />;
    case "user_message":
      return (
        <div className="flex flex-col gap-[8px]">
          {entry.reminders?.map((reminder, index) => (
            <div key={`${reminder.reason}:${index}`}>
              <SectionLabel>System reminder · {reminder.reason} (merged onto this message)</SectionLabel>
              <VerbatimText text={reminder.text} />
            </div>
          ))}
          <div>
            {entry.reminders?.length ? <SectionLabel>Message</SectionLabel> : null}
            <VerbatimText text={entry.text ?? ""} />
          </div>
          {entry.attachments?.length ? (
            <div>
              <SectionLabel>Attachments</SectionLabel>
              <ul className="list-none font-mono text-[11.5px] text-[var(--text-primary)]">
                {entry.attachments.map((attachment, index) => (
                  <li key={`${attachment.name ?? attachment.mimeType}:${index}`}>
                    {attachment.name ?? "(unnamed)"}{" "}
                    <span className="text-[var(--text-secondary)]">
                      {attachment.mimeType}
                      {attachment.size != null ? ` · ${attachment.size.toLocaleString()} bytes` : ""}
                      {attachment.kind === "image" ? " · sent as an image part (not counted above)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    case "compaction_summary":
      return (
        <div className="flex flex-col gap-[8px]">
          {entry.compaction ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-[12px] gap-y-[2px] font-sans text-[11.5px]">
              <dt className="text-[var(--text-secondary)]">Compressed turns</dt>
              <dd className="tabular-nums text-[var(--text-primary)]">{entry.compaction.compressedTurnCount}</dd>
              <dt className="text-[var(--text-secondary)]">Retained turns</dt>
              <dd className="tabular-nums text-[var(--text-primary)]">{entry.compaction.retainedTurnCount}</dd>
              {entry.compaction.sourceRange ? (
                <>
                  <dt className="text-[var(--text-secondary)]">Source events</dt>
                  <dd className="tabular-nums text-[var(--text-primary)]">
                    #{entry.compaction.sourceRange.fromSeq} – #{entry.compaction.sourceRange.toSeq}
                  </dd>
                </>
              ) : null}
              {entry.compaction.estimatedTokensBefore != null ? (
                <>
                  <dt className="text-[var(--text-secondary)]">Estimated before → after</dt>
                  <dd className="tabular-nums text-[var(--text-primary)]">
                    {formatContextTokenCount(entry.compaction.estimatedTokensBefore)} →{" "}
                    {entry.compaction.estimatedTokensAfter != null
                      ? formatContextTokenCount(entry.compaction.estimatedTokensAfter)
                      : "?"}
                  </dd>
                </>
              ) : null}
              {entry.compaction.generation != null ? (
                <>
                  <dt className="text-[var(--text-secondary)]">Generation</dt>
                  <dd className="tabular-nums text-[var(--text-primary)]">{entry.compaction.generation}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <div>
            <SectionLabel>Summary · replayed as a user message</SectionLabel>
            <VerbatimText text={entry.text ?? ""} />
          </div>
        </div>
      );
    default:
      return <VerbatimText text={entry.text ?? ""} />;
  }
}

/** Mount the (potentially huge) body only once the card scrolls near the viewport. */
function NearViewport({ children, force }: { children: ReactNode; force?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || force) {
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) {
          observer.disconnect();
          setNear(true);
        }
      },
      { rootMargin: "800px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [force, near]);
  return (
    <div ref={ref}>
      {near || force ? children : <div className="h-[48px]" aria-hidden />}
    </div>
  );
}

function EntryCard({
  entry,
  index,
  selected,
  rawAll,
}: {
  entry: AgentContextTranscriptEntry;
  index: number;
  selected: boolean;
  rawAll: boolean;
}) {
  const [rawLocal, setRawLocal] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = rawLocal ?? rawAll;
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (selected) {
      ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selected]);

  const copyPayload = useCallback(async () => {
    const text = raw
      ? prettyJson(entry.events && entry.events.length > 0 ? entry.events : entry.tools ?? entry.text ?? "")
      : entry.toolCall
        ? [
            `${entry.toolCall.name} ${typeof entry.toolCall.arguments === "string" ? entry.toolCall.arguments : prettyJson(entry.toolCall.arguments ?? {})}`,
            entry.toolCall.result ?? "",
          ].join("\n\n")
        : entry.text ?? "";
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    }
  }, [entry, raw]);

  const seqLabel =
    entry.seqStart != null
      ? entry.seqEnd != null && entry.seqEnd !== entry.seqStart
        ? `#${entry.seqStart}–${entry.seqEnd}`
        : `#${entry.seqStart}`
      : "static";

  return (
    <article
      ref={ref}
      id={`context-entry-${entry.id}`}
      data-context-entry
      data-context-entry-kind={entry.kind}
      className={`scroll-mt-[8px] rounded-[8px] border bg-[var(--bg-card)] transition-shadow ${
        selected
          ? "border-[var(--text-primary)] shadow-[0_0_0_1px_var(--text-primary)]"
          : "border-[var(--border-card)]"
      }`}
      style={{ borderLeft: `3px solid ${contextColor(entry.colorKey)}` }}
    >
      <header className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px] px-[10px] py-[7px]">
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand block" : "Collapse block"}
          className="flex size-[18px] shrink-0 items-center justify-center rounded-[4px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)]"
        >
          {collapsed ? (
            <ChevronRight className="size-[13px]" strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronDown className="size-[13px]" strokeWidth={1.75} aria-hidden />
          )}
        </button>
        <span className="w-[28px] shrink-0 text-right font-mono text-[10.5px] tabular-nums text-[var(--text-disabled)]">
          {index + 1}
        </span>
        <span
          className="shrink-0 rounded-full px-[7px] py-[1px] font-sans text-[10.5px] font-medium"
          style={{
            background: `color-mix(in srgb, ${contextColor(entry.colorKey)} 18%, transparent)`,
            color: contextColor(entry.colorKey),
          }}
        >
          {KIND_BADGE[entry.kind] ?? entry.kind}
        </span>
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[var(--text-primary)]" title={entry.label}>
          {entry.label}
          {entry.detail && entry.detail !== entry.label ? (
            <span className="text-[var(--text-secondary)]"> · {entry.detail}</span>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--text-secondary)]">
          {seqLabel}
        </span>
        {entry.createdAt ? (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--text-disabled)]">
            {formatClock(entry.createdAt)}
          </span>
        ) : null}
        <span className="shrink-0 rounded-[4px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-sans text-[11px] font-medium tabular-nums text-[var(--text-primary)]">
          ~{formatContextTokenCount(entry.tokens)}
        </span>
        <button
          type="button"
          onClick={() => setRawLocal(!raw)}
          aria-pressed={raw}
          title={raw ? "Show formatted" : "Show the raw stored payload"}
          className={`flex shrink-0 items-center gap-[4px] rounded-[4px] px-[6px] py-[2px] font-sans text-[10.5px] transition-colors ${
            raw
              ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Braces className="size-[11px]" strokeWidth={1.75} aria-hidden />
          Raw
        </button>
        <button
          type="button"
          onClick={() => void copyPayload()}
          title="Copy this block"
          aria-label="Copy this block"
          className="flex size-[20px] shrink-0 items-center justify-center rounded-[4px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          {copied ? (
            <Check className="size-[12px] text-[var(--status-success)]" strokeWidth={2} aria-hidden />
          ) : (
            <Copy className="size-[12px]" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </header>
      {!collapsed ? (
        <div className="border-t border-[var(--border-subtle)] px-[10px] py-[10px]">
          <NearViewport force={selected}>
            <EntryBody entry={entry} raw={raw} />
          </NearViewport>
        </div>
      ) : null}
    </article>
  );
}

function entryMatches(entry: AgentContextTranscriptEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystacks = [
    entry.label,
    entry.detail ?? "",
    entry.text ?? "",
    entry.toolCall?.name ?? "",
    entry.toolCall?.result ?? "",
    entry.toolCall?.arguments ? (typeof entry.toolCall.arguments === "string" ? entry.toolCall.arguments : prettyJson(entry.toolCall.arguments)) : "",
    entry.reminders?.map((reminder) => reminder.text).join("\n") ?? "",
    entry.tools?.map((tool) => `${tool.name} ${tool.description}`).join("\n") ?? "",
  ];
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

export function ContextInspectorView({ conversationId }: { conversationId: string }) {
  const agentConversations = useOptionalAgentConversations();
  const record = agentConversations?.conversationsById[conversationId] ?? null;
  const backendLabel =
    agentConversations?.backends.find((backend) => backend.id === record?.config.backendId)?.label ??
    record?.config.backendId ??
    null;

  const [transcript, setTranscript] = useState<AgentContextTranscript | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useContextUsageViewMode();
  const [rawAll, setRawAll] = useState(false);
  const [query, setQuery] = useState("");
  const [hiddenCategories, setHiddenCategories] = useState<Set<AgentContextUsageCategoryId>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    if (!conversationId) {
      setLoading(false);
      setError("No conversation selected.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (hasDataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const { transcript: next } = await fetchAgentContextTranscript(conversationId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setTranscript(next);
      hasDataRef.current = true;
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Failed to load the context transcript.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Follow the live conversation: re-read after new events settle, and the
  // moment a turn finishes so compaction/tool results show up immediately.
  const lastEventSeq = record?.lastEventSeq ?? 0;
  const status = record?.status ?? "idle";
  const previousStatusRef = useRef(status);
  useEffect(() => {
    if (!hasDataRef.current) return;
    const timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [lastEventSeq, load]);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (previous !== "idle" && status === "idle" && hasDataRef.current) {
      void load();
    }
  }, [load, status]);

  const usage = transcript?.usage ?? null;
  const entries = useMemo(() => transcript?.entries ?? [], [transcript]);
  const limitTokens = usage?.limitTokens ?? 0;

  const barSegments = useMemo<ContextUsageBarSegment[]>(() => {
    if (!usage) return [];
    if (mode === "pooled") return usage.categories;
    // The inspector is wide: condense far less aggressively than the dock.
    return condenseContextTimeline(usage.timeline ?? [], {
      minTokens: Math.round(contextTimelineCondenseThreshold(limitTokens) / 4),
    });
  }, [limitTokens, mode, usage]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<AgentContextUsageCategoryId, number>();
    for (const entry of entries) {
      totals.set(entry.categoryId, (totals.get(entry.categoryId) ?? 0) + entry.tokens);
    }
    return totals;
  }, [entries]);

  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (entry) => !hiddenCategories.has(entry.categoryId) && entryMatches(entry, query)
      ),
    [entries, hiddenCategories, query]
  );
  const entryIndexById = useMemo(
    () => new Map(entries.map((entry, index) => [entry.id, index] as const)),
    [entries]
  );

  const kindCounts = useMemo(() => {
    const counts = new Map<AgentContextSegmentKind, number>();
    for (const entry of entries) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const jumpToSegment = useCallback(
    (segmentId: string) => {
      if (!usage) return;
      if (mode === "pooled") {
        // Category segment: reveal that category alone and jump to its first block.
        const category = usage.categories.find((row) => row.id === segmentId);
        if (!category) return;
        const first = entries.find((entry) => entry.categoryId === category.id);
        if (first) setSelectedId(first.id);
        return;
      }
      const condensed = barSegments.find((segment) => segment.id === segmentId);
      const targetId = segmentId.startsWith("group:")
        ? (condensed as { segmentIds?: string[] } | undefined)?.segmentIds?.[0] ?? null
        : segmentId;
      if (targetId) setSelectedId(targetId);
    },
    [barSegments, entries, mode, usage]
  );

  const toggleCategory = (id: AgentContextUsageCategoryId) => {
    setHiddenCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && !transcript) {
    return (
      <div className="flex h-full items-center justify-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
        <LoaderCircle className="size-[16px] animate-spin" strokeWidth={1.6} aria-hidden />
        Reconstructing the context window…
      </div>
    );
  }

  if (error && !transcript) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[10px] px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!transcript || !usage) {
    return null;
  }

  const supported = usage.supported;
  const title = record?.title?.trim() || "Conversation";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]" data-context-inspector>
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-[16px] pb-[10px] pt-[14px]">
        <div className="flex items-start justify-between gap-[12px]">
          <div className="flex min-w-0 items-start gap-[10px]">
            <ContextUsageRing percent={usage.percentFull} loading={false} className="mt-[3px] shrink-0" />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-[8px]">
                <Layers className="size-[15px] shrink-0 text-[var(--context-usage-conversation)]" strokeWidth={1.75} aria-hidden />
                <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold text-[var(--text-primary)]">
                  Context inspector
                </h1>
                <span className="min-w-0 truncate font-sans text-[13px] text-[var(--text-secondary)]" title={title}>
                  {title}
                </span>
              </div>
              <div className="mt-[4px] flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
                {supported ? (
                  <span>
                    <span className="text-[var(--text-primary)]">{usage.percentFull}%</span> Full ·{" "}
                    {formatContextUsagePair(usage.usedTokens, usage.limitTokens)}
                  </span>
                ) : (
                  <span>
                    ~{formatContextTokenCount(usage.usedTokens)} tokens reconstructed · window unknown
                  </span>
                )}
                {backendLabel ? (
                  <code className="rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-mono text-[10.5px]">
                    {backendLabel}
                  </code>
                ) : null}
                {transcript.modelId ? (
                  <code className="truncate rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-mono text-[10.5px]">
                    {transcript.modelId}
                  </code>
                ) : null}
                <span className="tabular-nums">
                  {entries.length} block{entries.length === 1 ? "" : "s"}
                  {kindCounts.get("tool_call") ? ` · ${kindCounts.get("tool_call")} tool calls` : ""}
                  {kindCounts.get("compaction_summary")
                    ? ` · ${kindCounts.get("compaction_summary")} compaction${kindCounts.get("compaction_summary") === 1 ? "" : "s"}`
                    : ""}
                </span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[6px]">
            <div
              role="radiogroup"
              aria-label="Context bar view"
              className="flex items-center gap-[2px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[2px]"
            >
              {(["pooled", "sequential"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={mode === candidate}
                  onClick={() => setMode(candidate)}
                  className={`rounded-[calc(var(--radius-tab)-2px)] px-[8px] py-[3px] font-sans text-[11px] font-medium transition-colors ${
                    mode === candidate
                      ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {candidate === "pooled" ? "Pooled" : "Sequential"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRawAll((current) => !current)}
              aria-pressed={rawAll}
              title="Show every block as its raw stored payload"
              className={`flex h-[26px] items-center gap-[5px] rounded-[var(--radius-tab)] border px-[8px] font-sans text-[11px] font-medium transition-colors ${
                rawAll
                  ? "border-[var(--border-card)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                  : "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Braces className="size-[12px]" strokeWidth={1.75} aria-hidden />
              Raw
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={refreshing}
              title="Refresh"
              aria-label="Refresh context transcript"
              className="flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
            >
              <RefreshCw className={`size-[12px] ${refreshing ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>

        {usage.usedTokens > 0 ? (
          <ContextUsageBar
            segments={barSegments}
            separated={mode === "sequential"}
            heightClass="h-[10px]"
            className="mt-[12px]"
            hoveredId={hoveredId}
            onHover={setHoveredId}
            selectedId={
              mode === "sequential"
                ? barSegments.find(
                    (segment) =>
                      segment.id === selectedId ||
                      (segment as { segmentIds?: string[] }).segmentIds?.includes(selectedId ?? "")
                  )?.id ?? null
                : null
            }
            onSelect={jumpToSegment}
            ariaLabel={
              mode === "sequential"
                ? "Context blocks in the order the model receives them - click to jump"
                : "Context usage by category - click to jump to the first block"
            }
          />
        ) : null}

        <div className="mt-[8px] flex flex-wrap items-center gap-[6px]">
          {CATEGORY_ORDER.filter((id) => (categoryTotals.get(id) ?? 0) > 0 || entries.some((entry) => entry.categoryId === id)).map((id) => {
            const hidden = hiddenCategories.has(id);
            const label = usage.categories.find((row) => row.id === id)?.label ?? id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleCategory(id)}
                aria-pressed={!hidden}
                className={`flex items-center gap-[6px] rounded-full border px-[8px] py-[2px] font-sans text-[11px] transition-colors ${
                  hidden
                    ? "border-[var(--border-card)] text-[var(--text-disabled)] line-through"
                    : "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
                }`}
              >
                <span
                  className="size-[9px] rounded-[2px]"
                  style={{ background: contextColor(usage.categories.find((row) => row.id === id)?.colorKey ?? id), opacity: hidden ? 0.4 : 1 }}
                  aria-hidden
                />
                {label}
                <span className="tabular-nums text-[var(--text-secondary)]">
                  {formatContextTokenCount(categoryTotals.get(id) ?? 0)}
                </span>
              </button>
            );
          })}
          <label className="ml-auto flex min-w-[180px] max-w-[320px] flex-1 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[3px]">
            <Search className="size-[12px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search blocks, tool output, prompts…"
              aria-label="Search context blocks"
              className="min-w-0 flex-1 bg-transparent font-sans text-[11.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="flex size-[16px] items-center justify-center rounded-[3px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <X className="size-[11px]" strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
          </label>
        </div>

        {transcript.notes.length > 0 ? (
          <ul className="mt-[8px] list-none space-y-[2px] font-sans text-[10.5px] leading-snug text-[var(--text-disabled)]">
            {transcript.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="mt-[6px] font-sans text-[11px] text-[var(--status-error)]">{error}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[16px] py-[12px]">
        {visibleEntries.length === 0 ? (
          <p className="py-[24px] text-center font-sans text-[12.5px] text-[var(--text-secondary)]">
            {entries.length === 0
              ? "Nothing has entered this context window yet."
              : "No blocks match the current filters."}
          </p>
        ) : (
          <ol className="flex list-none flex-col gap-[8px]">
            {visibleEntries.map((entry) => (
              <li key={entry.id}>
                <EntryCard
                  entry={entry}
                  index={entryIndexById.get(entry.id) ?? 0}
                  selected={selectedId === entry.id}
                  rawAll={rawAll}
                />
              </li>
            ))}
          </ol>
        )}
        {visibleEntries.length !== entries.length ? (
          <p className="pt-[10px] text-center font-sans text-[11px] text-[var(--text-disabled)]">
            Showing {visibleEntries.length} of {entries.length} blocks
            {query ? ` matching "${query}"` : ""}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

