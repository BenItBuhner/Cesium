import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPiAgentDir } from "../../../pi-agent-settings.js";
import type { AgentEventInput } from "../../types.js";
import type {
  HarnessImportAvailability,
  HarnessImportSource,
  HarnessSessionSummary,
  HarnessSessionTranscript,
} from "../types.js";
import {
  asRecord,
  asString,
  clampDetail,
  extractToolOutputText,
  inferToolKind,
  listFilesRecursive,
  pathExists,
  readJsonLines,
  summarizeToolInput,
  toEpochMs,
  truncateTitle,
} from "../reader-utils.js";

/**
 * Pi (pi-mono coding agent) stores one JSONL file per session:
 *   <agentDir>/sessions/--<cwd-slug>--/<isoTs>_<sessionId>.jsonl
 * Line 1 is the header { type: "session", version, id, timestamp, cwd };
 * following lines form a parent-linked tree of entries — message (user /
 * assistant / toolResult), model_change, thinking_level_change, etc.
 * Assistant content blocks: text | thinking | toolCall; tool results are
 * standalone { role: "toolResult", toolCallId, toolName, content, isError }
 * messages.
 */

function piSessionsRoot(): string {
  return path.join(getPiAgentDir(), "sessions");
}

/** Mirrors pi-agent-provider's piNativeSessionDirForCwd slug formula. */
export function piNativeSessionDirForCwd(cwd: string, agentDir?: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(agentDir ?? getPiAgentDir()), "sessions", safePath);
}

type PiEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  version?: number;
  message?: {
    role?: string;
    content?: PiContentBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
  };
};

type PiContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

async function findSessionFile(sessionId: string): Promise<string | null> {
  const files = (await listFilesRecursive(piSessionsRoot())).filter((file) =>
    file.endsWith(".jsonl")
  );
  const matches: string[] = [];
  for (const file of files) {
    if (path.basename(file).includes(sessionId)) {
      matches.push(file);
    }
  }
  // Fall back to header inspection (ids are also embedded in the filename by
  // convention, but custom --session-dir layouts may differ).
  if (matches.length === 0) {
    for (const file of files) {
      try {
        const handle = await fs.open(file, "r");
        try {
          const buffer = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
          const header = asRecord(JSON.parse(firstLine));
          if (asString(header?.id) === sessionId) {
            matches.push(file);
          }
        } finally {
          await handle.close();
        }
      } catch {
        // unreadable file — skip
      }
    }
  }
  // Re-homed copies the harness kept writing to are authoritative (mtime,
  // then append-only size as tie-break).
  let best: { file: string; mtimeMs: number; size: number } | null = null;
  for (const file of matches) {
    try {
      const stat = await fs.stat(file);
      if (
        !best ||
        stat.mtimeMs > best.mtimeMs ||
        (stat.mtimeMs === best.mtimeMs && stat.size > best.size)
      ) {
        best = { file, mtimeMs: stat.mtimeMs, size: stat.size };
      }
    } catch {
      // ignore
    }
  }
  return best?.file ?? null;
}

async function readSessionEntries(file: string): Promise<{ header: PiEntry | null; entries: PiEntry[] }> {
  const lines = (await readJsonLines(file)) as PiEntry[];
  const header = lines.find((entry) => entry.type === "session") ?? null;
  return { header, entries: lines };
}

function summarizePiSession(
  entries: PiEntry[],
  header: PiEntry | null,
  sourcePath: string,
  sessionId: string,
  statMtime: number | null
): HarnessSessionSummary {
  let preview: string | undefined;
  let messageCount = 0;
  let updatedAt: number | null = null;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const ts = toEpochMs(entry.timestamp);
    if (ts !== null) {
      updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
    }
    const role = entry.message.role;
    if (role === "user") {
      const text = (entry.message.content ?? [])
        .filter((block) => block.type === "text" && block.text?.trim())
        .map((block) => block.text!)
        .join("\n");
      if (!text.trim()) {
        continue;
      }
      messageCount += 1;
      if (!preview) {
        preview = truncateTitle(text, 120);
      }
    } else if (role === "assistant") {
      const hasVisible = (entry.message.content ?? []).some(
        (block) =>
          (block.type === "text" && block.text?.trim()) ||
          block.type === "toolCall" ||
          (block.type === "thinking" && block.thinking?.trim())
      );
      if (hasVisible) {
        messageCount += 1;
      }
    }
  }
  return {
    id: sessionId,
    title: preview ?? `Pi session ${sessionId.slice(0, 8)}`,
    ...(header?.cwd ?? entries.find((entry) => entry.cwd)?.cwd
      ? { cwd: header?.cwd ?? entries.find((entry) => entry.cwd)!.cwd! }
      : {}),
    createdAt: toEpochMs(header?.timestamp),
    updatedAt: updatedAt ?? statMtime,
    messageCount,
    sourcePath,
    ...(preview ? { preview } : {}),
  };
}

export function mapPiEntriesToEvents(entries: PiEntry[], conversationId: string): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  let lastTs: number | null = null;
  const nextTime = (entry: PiEntry): number => {
    const ts = toEpochMs(entry.timestamp) ?? toEpochMs(entry.message?.timestamp);
    if (ts !== null) {
      lastTs = lastTs === null ? ts : Math.max(ts, lastTs + 1);
      return lastTs;
    }
    lastTs = (lastTs ?? Date.now()) + 1;
    return lastTs;
  };
  const toolCallIndexByCallId = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const message = entry.message;
    const entryId = entry.id ?? randomUUID();
    const createdAt = nextTime(entry);

    if (message.role === "user") {
      const text = (message.content ?? [])
        .filter((block) => block.type === "text" && block.text?.trim())
        .map((block) => block.text!)
        .join("\n");
      if (!text.trim()) {
        continue;
      }
      events.push({
        eventId: entryId,
        conversationId,
        kind: "user_message",
        messageId: entryId,
        content: text,
        createdAt,
      });
      continue;
    }

    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "thinking" && block.thinking?.trim()) {
          events.push({
            eventId: randomUUID(),
            conversationId,
            kind: "reasoning",
            messageId: entryId,
            text: block.thinking,
            createdAt,
          });
          continue;
        }
        if (block.type === "toolCall" && block.name) {
          const toolCallId = block.id ?? randomUUID();
          toolCallIndexByCallId.set(toolCallId, events.length);
          events.push({
            eventId: randomUUID(),
            conversationId,
            kind: "tool_call",
            toolCallId,
            title: block.name,
            toolKind: inferToolKind(block.name),
            status: "completed",
            ...(clampDetail(summarizeToolInput(block.arguments))
              ? { detail: clampDetail(summarizeToolInput(block.arguments)) }
              : {}),
            createdAt,
          });
          continue;
        }
      }
      const text = (message.content ?? [])
        .filter((block) => block.type === "text" && block.text?.trim())
        .map((block) => block.text!)
        .join("");
      if (text.trim()) {
        events.push(
          {
            eventId: randomUUID(),
            conversationId,
            kind: "assistant_message_chunk",
            messageId: entryId,
            text,
            createdAt,
          },
          {
            eventId: `${entryId}:end`,
            conversationId,
            kind: "assistant_message_end",
            messageId: entryId,
            stopReason: "end_turn",
            createdAt: createdAt + 1,
          }
        );
      }
      continue;
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const output = clampDetail(extractToolOutputText(message.content));
      const targetIndex = toolCallIndexByCallId.get(message.toolCallId);
      const target = targetIndex !== undefined ? events[targetIndex] : undefined;
      if (output !== undefined && target && target.kind === "tool_call") {
        events.push({
          eventId: randomUUID(),
          conversationId,
          kind: "tool_call_update",
          toolCallId: message.toolCallId,
          status: message.isError ? "failed" : "completed",
          detail: [target.detail, output].filter(Boolean).join("\n\n--- Output ---\n\n"),
          createdAt,
        });
      }
    }
  }
  return events;
}

export function createPiImportSource(): HarnessImportSource {
  return {
    harnessKey: "pi",
    backendIds: ["pi-agent"],
    displayName: "Pi",

    async detect(): Promise<HarnessImportAvailability> {
      const root = piSessionsRoot();
      if (await pathExists(root)) {
        return { available: true, storageRoot: root };
      }
      return {
        available: false,
        reason: `No Pi sessions found (${root} does not exist).`,
        storageRoot: root,
      };
    },

    async listSessions(): Promise<HarnessSessionSummary[]> {
      const files = (await listFilesRecursive(piSessionsRoot())).filter((file) =>
        file.endsWith(".jsonl")
      );
      const summaries: HarnessSessionSummary[] = [];
      for (const file of files) {
        let statMtime: number | null = null;
        try {
          statMtime = (await fs.stat(file)).mtimeMs;
        } catch {
          // ignore
        }
        const { header, entries } = await readSessionEntries(file);
        const sessionId =
          asString(header?.id) ?? path.basename(file, ".jsonl").split("_").pop() ?? "";
        if (!sessionId) {
          continue;
        }
        summaries.push(summarizePiSession(entries, header, file, sessionId, statMtime));
      }
      return summaries.sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
      );
    },

    async readSession(sessionId: string): Promise<HarnessSessionTranscript> {
      const file = await findSessionFile(sessionId);
      if (!file) {
        throw new Error(`Pi session not found: ${sessionId}`);
      }
      let statMtime: number | null = null;
      try {
        statMtime = (await fs.stat(file)).mtimeMs;
      } catch {
        // ignore
      }
      const { header, entries } = await readSessionEntries(file);
      const resolvedId = asString(header?.id) ?? sessionId;
      const summary = summarizePiSession(entries, header, file, resolvedId, statMtime);
      const events = mapPiEntriesToEvents(entries, "");
      const startTs = toEpochMs(header?.timestamp);
      return {
        summary,
        events,
        ...(startTs ? { startedAt: new Date(startTs).toISOString() } : {}),
      };
    },

    async prepareNativeResume(sessionId: string, workspaceRoot: string): Promise<string> {
      const source = await findSessionFile(sessionId);
      if (!source) {
        return sessionId;
      }
      const targetDir = piNativeSessionDirForCwd(workspaceRoot);
      const target = path.join(targetDir, path.basename(source));
      if (path.resolve(source) !== path.resolve(target)) {
        try {
          const [sourceStat, targetStat] = await Promise.all([
            fs.stat(source),
            fs.stat(target).catch(() => null),
          ]);
          // Never clobber a re-homed file the harness kept appending to.
          if (!targetStat || targetStat.mtimeMs < sourceStat.mtimeMs) {
            await fs.mkdir(targetDir, { recursive: true });
            await fs.copyFile(source, target);
          }
        } catch (error) {
          console.warn(
            `[agent-import] failed to re-home ${source} -> ${target}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      // The Pi provider opens .jsonl paths directly, which works regardless of
      // the session-dir layout the SDK picks for this workspace.
      return target;
    },
  };
}
