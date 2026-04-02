import type { ChatMessage, WorkedSessionEntry } from "@/lib/types";

type OpenCodeExportPart = Record<string, unknown> & { type?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeToolKind(
  value: string | undefined
): "read" | "edit" | "search" | "grep" | "terminal" | "todo" | "tool" {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("read")) return "read";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "edit";
  if (lower.includes("grep")) return "grep";
  if (lower.includes("glob") || lower.includes("search") || lower.includes("find")) return "search";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("command")) return "terminal";
  if (lower.includes("todo")) return "todo";
  return "tool";
}

function summarizeWorkedEntriesLabel(entries: WorkedSessionEntry[]): string {
  const tools = entries.filter(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> => entry.kind === "tool"
  );
  const thoughtCount = entries.filter((entry) => entry.kind === "reasoning").length;
  if (tools.length === 0) {
    if (thoughtCount > 0) {
      return thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`;
    }
    return "Worked session";
  }
  const orderedBuckets: Array<{ kind: string; count: number; files: Set<string> }> = [];
  const bucketByKind = new Map<string, (typeof orderedBuckets)[number]>();
  for (const tool of tools) {
    const kind = tool.toolKind ?? "tool";
    const bucket =
      bucketByKind.get(kind) ??
      (() => {
        const created = { kind, count: 0, files: new Set<string>() };
        bucketByKind.set(kind, created);
        orderedBuckets.push(created);
        return created;
      })();
    bucket.count += 1;
    for (const file of tool.files ?? []) {
      bucket.files.add(file);
    }
  }
  const segments = orderedBuckets
    .map((bucket) => summarizeWorkedToolBucket(bucket.kind, bucket.count, bucket.files.size))
    .concat(thoughtCount > 0 ? [thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`] : []);
  return capitalizeFirst(segments.join(", "));
}

function summarizeWorkedToolBucket(kind: string, count: number, fileCount: number): string {
  const resolvedCount = fileCount > 0 ? fileCount : count;
  switch (kind) {
    case "read":
      return resolvedCount === 1 ? "read 1 file" : `read ${resolvedCount} files`;
    case "edit":
      return resolvedCount === 1 ? "edited 1 file" : `edited ${resolvedCount} files`;
    case "grep":
      return count === 1 ? "grepped" : `grepped ${count} times`;
    case "search":
      return count === 1 ? "searched workspace" : `searched workspace ${count} times`;
    case "terminal":
      return count === 1 ? "ran a command" : `ran ${count} commands`;
    case "todo":
      return count === 1 ? "updated todo list" : `updated todo list ${count} times`;
    default:
      return count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

function capitalizeFirst(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function toolTitle(toolName: string, state: Record<string, unknown> | undefined): string {
  const input = asRecord(state?.input);
  const path =
    (typeof input?.filePath === "string" && input.filePath) ||
    (typeof input?.path === "string" && input.path) ||
    undefined;
  const pattern =
    (typeof input?.pattern === "string" && input.pattern) ||
    (typeof input?.glob === "string" && input.glob) ||
    (typeof input?.globPattern === "string" && input.globPattern) ||
    undefined;
  const command =
    (typeof input?.command === "string" && input.command) ||
    (typeof input?.cmd === "string" && input.cmd) ||
    undefined;
  switch (toolName) {
    case "read":
      return path ? `Read ${path}` : "Read file";
    case "glob":
      return pattern ? `Find "${pattern}"` : "Find files";
    case "grep":
      return pattern ? `Grep "${pattern}"` : "Grep files";
    case "bash":
      return command || "Run command";
    default:
      return path ? `${toolName} ${path}` : toolName.replace(/_/g, " ");
  }
}

function toolFiles(state: Record<string, unknown> | undefined): string[] | undefined {
  const input = asRecord(state?.input);
  const filePath =
    (typeof input?.filePath === "string" && input.filePath) ||
    (typeof input?.path === "string" && input.path) ||
    undefined;
  if (filePath) {
    return [filePath];
  }
  return undefined;
}

function toolDetail(state: Record<string, unknown> | undefined): string | undefined {
  const metadata = asRecord(state?.metadata);
  if (typeof metadata?.preview === "string" && metadata.preview.trim()) {
    return metadata.preview.trim();
  }
  const output = state?.output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
  }
  return undefined;
}

function toolStatus(
  state: Record<string, unknown> | undefined
): Extract<WorkedSessionEntry, { kind: "tool" }>["status"] {
  const status = typeof state?.status === "string" ? state.status : "completed";
  if (status === "pending") return "pending";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function flushWorked(
  messages: ChatMessage[],
  workedEntries: WorkedSessionEntry[],
  baseId: string,
  segmentIndexRef: { value: number }
): void {
  if (workedEntries.length === 0) {
    return;
  }
  messages.push({
    id: `${baseId}-worked-${segmentIndexRef.value++}`,
    type: "worked-session",
    workedLabel: summarizeWorkedEntriesLabel(workedEntries),
    workedEntries: [...workedEntries],
    workedDefaultOpen: true,
  });
  workedEntries.length = 0;
}

function mergeAdjacentWorkedSessions(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous?.type === "worked-session" &&
      message.type === "worked-session"
    ) {
      previous.workedEntries = [
        ...(previous.workedEntries ?? []),
        ...(message.workedEntries ?? []),
      ];
      previous.workedLabel = summarizeWorkedEntriesLabel(previous.workedEntries ?? []);
      previous.loading = previous.loading || message.loading;
      continue;
    }
    merged.push(message);
  }
  return merged;
}

export function projectOpenCodeExportToChatMessages(session: unknown): {
  messages: ChatMessage[];
  complete: boolean;
  title?: string;
} {
  const root = asRecord(session);
  const info = asRecord(root?.info);
  const exportedMessages = Array.isArray(root?.messages) ? root.messages : [];
  const messages: ChatMessage[] = [];
  const sessionTime = asRecord(info?.time);
  let complete = typeof sessionTime?.completed === "number";

  for (const rawMessage of exportedMessages) {
    const messageRecord = asRecord(rawMessage);
    const msgInfo = asRecord(messageRecord?.info);
    const role = typeof msgInfo?.role === "string" ? msgInfo.role : "assistant";
    const messageId = typeof msgInfo?.id === "string" ? msgInfo.id : `msg-${messages.length}`;
    const parts = Array.isArray(messageRecord?.parts) ? messageRecord.parts : [];

    if (role === "user") {
      const text = parts
        .map((part) => {
          const record = asRecord(part);
          return record?.type === "text" && typeof record.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (text) {
        messages.push({
          id: messageId,
          type: "user",
          content: text,
        });
      }
      continue;
    }

    const workedEntries: WorkedSessionEntry[] = [];
    const segmentIndexRef = { value: 0 };
    for (const part of parts) {
      const record = asRecord(part) as OpenCodeExportPart | undefined;
      if (!record?.type) {
        continue;
      }
      if (record.type === "reasoning" && typeof record.text === "string" && record.text.trim()) {
        workedEntries.push({ kind: "reasoning", text: record.text.trim() });
        continue;
      }
      if (record.type === "tool") {
        const toolName = typeof record.tool === "string" ? record.tool : "tool";
        const state = asRecord(record.state);
        workedEntries.push({
          kind: "tool",
          toolCallId: typeof record.callID === "string" ? record.callID : undefined,
          toolKind: normalizeToolKind(toolName),
          title: toolTitle(toolName, state),
          detail: toolDetail(state),
          status: toolStatus(state),
          files: toolFiles(state),
        });
        continue;
      }
      if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
        flushWorked(messages, workedEntries, messageId, segmentIndexRef);
        messages.push({
          id: `${messageId}-assistant-${segmentIndexRef.value++}`,
          type: "assistant",
          content: record.text,
        });
        continue;
      }
    }
    flushWorked(messages, workedEntries, messageId, segmentIndexRef);
  }

  const mergedMessages = mergeAdjacentWorkedSessions(messages);

  if (!complete && mergedMessages.every((message) => message.type === "user")) {
    mergedMessages.push({
      id: `subagent-working-${mergedMessages.length}`,
      type: "worked-session",
      workedLabel: "Working",
      workedEntries: [],
      workedDefaultOpen: false,
      loading: true,
    });
  }

  return {
    messages: mergedMessages,
    complete,
    title: typeof info?.title === "string" ? info.title : undefined,
  };
}
