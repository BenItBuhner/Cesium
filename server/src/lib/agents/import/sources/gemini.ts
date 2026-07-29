import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  pathExists,
  readJsonLines,
  summarizeToolInput,
  toEpochMs,
  truncateTitle,
} from "../reader-utils.js";

/**
 * Gemini CLI / Google Antigravity store chat checkpoints per project:
 *   ~/.gemini/tmp/<sha256(projectRoot)>/chats/session-<ts>-<shortId>.jsonl
 * Newer builds append JSONL records: a metadata header
 * { sessionId, projectHash, startTime, lastUpdated, kind, directories },
 * then one record per message ({ id, timestamp, type: "user" | "gemini" |
 * "info" | "error" | "warning", content, displayContent, toolCalls?,
 * thoughts?, model? }) plus { $set } metadata patches and { $rewindTo }
 * truncation markers. Older builds wrote the whole conversation as a single
 * .json document — both are supported.
 */

function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME?.trim() || path.join(os.homedir(), ".gemini");
}

function geminiTmpRoot(): string {
  return path.join(geminiHome(), "tmp");
}

export function geminiProjectHashForCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

export function geminiChatsDirForCwd(cwd: string): string {
  return path.join(geminiTmpRoot(), geminiProjectHashForCwd(cwd), "chats");
}

type GeminiMessageRecord = {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  displayContent?: unknown;
  toolCalls?: GeminiToolCallRecord[];
  thoughts?: GeminiThoughtRecord[];
  model?: string;
};

type GeminiToolCallRecord = {
  id?: string;
  name?: string;
  args?: unknown;
  status?: string;
  result?: unknown;
  resultDisplay?: unknown;
  output?: unknown;
  error?: unknown;
};

type GeminiThoughtRecord = {
  subject?: string;
  description?: string;
  timestamp?: string;
};

type GeminiConversation = {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  kind?: string;
  directories?: string[];
  summary?: string;
  messages: GeminiMessageRecord[];
};

function partText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const rec = asRecord(item);
        if (!rec) {
          return "";
        }
        if (typeof rec.text === "string") {
          return rec.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  const rec = asRecord(content);
  if (rec && typeof rec.text === "string") {
    return rec.text;
  }
  return "";
}

async function readConversationFile(file: string): Promise<GeminiConversation | null> {
  if (file.endsWith(".jsonl")) {
    const records = (await readJsonLines(file)) as Record<string, unknown>[];
    let metadata: GeminiConversation | null = null;
    const messages: GeminiMessageRecord[] = [];
    for (const record of records) {
      if (record.$rewindTo) {
        const target = asString(record.$rewindTo);
        const index = messages.findIndex((message) => message.id === target);
        if (index >= 0) {
          messages.splice(index);
        }
        continue;
      }
      if (record.$set) {
        const patch = asRecord(record.$set);
        if (metadata && patch) {
          Object.assign(metadata, patch);
        }
        continue;
      }
      if (record.sessionId && !record.type && !metadata) {
        metadata = {
          sessionId: asString(record.sessionId),
          ...(asString(record.projectHash) ? { projectHash: asString(record.projectHash) } : {}),
          ...(asString(record.startTime) ? { startTime: asString(record.startTime) } : {}),
          ...(asString(record.lastUpdated) ? { lastUpdated: asString(record.lastUpdated) } : {}),
          ...(asString(record.kind) ? { kind: asString(record.kind) } : {}),
          ...(Array.isArray(record.directories)
            ? { directories: record.directories.filter((d): d is string => typeof d === "string") }
            : {}),
          ...(asString(record.summary) ? { summary: asString(record.summary) } : {}),
          messages,
        };
        continue;
      }
      if (record.type) {
        messages.push(record as GeminiMessageRecord);
      }
    }
    if (!metadata) {
      return null;
    }
    metadata.messages = messages;
    return metadata;
  }

  try {
    const parsed = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
    if (!parsed || !asString(parsed.sessionId)) {
      return null;
    }
    return {
      sessionId: asString(parsed.sessionId),
      ...(asString(parsed.projectHash) ? { projectHash: asString(parsed.projectHash) } : {}),
      ...(asString(parsed.startTime) ? { startTime: asString(parsed.startTime) } : {}),
      ...(asString(parsed.lastUpdated) ? { lastUpdated: asString(parsed.lastUpdated) } : {}),
      ...(asString(parsed.summary) ? { summary: asString(parsed.summary) } : {}),
      messages: Array.isArray(parsed.messages)
        ? (parsed.messages as GeminiMessageRecord[])
        : [],
    };
  } catch {
    return null;
  }
}

async function listConversationFiles(): Promise<string[]> {
  const tmpRoot = geminiTmpRoot();
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(tmpRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tmpRoot, entry.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const projectDir of projectDirs) {
    const chatsDir = path.join(projectDir, "chats");
    try {
      for (const name of await fs.readdir(chatsDir)) {
        if (name.startsWith("session-") && (name.endsWith(".jsonl") || name.endsWith(".json"))) {
          files.push(path.join(chatsDir, name));
        }
      }
    } catch {
      // project without chats dir
    }
  }
  return files;
}

function summarizeConversation(
  conversation: GeminiConversation,
  sourcePath: string,
  sessionId: string,
  statMtime: number | null
): HarnessSessionSummary {
  let preview: string | undefined;
  let messageCount = 0;
  let updatedAt = toEpochMs(conversation.lastUpdated);
  for (const message of conversation.messages) {
    const ts = toEpochMs(message.timestamp);
    if (ts !== null) {
      updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
    }
    if (message.type === "user") {
      const text = partText(message.displayContent ?? message.content);
      if (!text.trim()) {
        continue;
      }
      messageCount += 1;
      if (!preview) {
        preview = truncateTitle(text, 120);
      }
    } else if (message.type === "gemini") {
      const hasVisible =
        partText(message.content).trim().length > 0 || (message.toolCalls?.length ?? 0) > 0;
      if (hasVisible) {
        messageCount += 1;
      }
    }
  }
  return {
    id: sessionId,
    title:
      conversation.summary?.trim()
        ? truncateTitle(conversation.summary)
        : (preview ?? `Gemini session ${sessionId.slice(0, 8)}`),
    ...(conversation.directories?.[0] ? { cwd: conversation.directories[0] } : {}),
    createdAt: toEpochMs(conversation.startTime),
    updatedAt: updatedAt ?? statMtime,
    messageCount,
    sourcePath,
    ...(preview ? { preview } : {}),
  };
}

export function mapGeminiMessagesToEvents(
  messages: GeminiMessageRecord[],
  conversationId: string
): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  let lastTs: number | null = null;
  const nextTime = (message: GeminiMessageRecord): number => {
    const ts = toEpochMs(message.timestamp);
    if (ts !== null) {
      lastTs = lastTs === null ? ts : Math.max(ts, lastTs + 1);
      return lastTs;
    }
    lastTs = (lastTs ?? Date.now()) + 1;
    return lastTs;
  };

  for (const message of messages) {
    const messageId = message.id ?? randomUUID();
    const createdAt = nextTime(message);
    if (message.type === "user") {
      const text = partText(message.displayContent ?? message.content);
      if (!text.trim()) {
        continue;
      }
      events.push({
        eventId: messageId,
        conversationId,
        kind: "user_message",
        messageId,
        content: text,
        createdAt,
      });
      continue;
    }
    if (message.type === "gemini") {
      const thoughts = (message.thoughts ?? [])
        .filter((thought) => thought.subject?.trim() || thought.description?.trim())
        .map((thought) =>
          [thought.subject?.trim() ? `**${thought.subject.trim()}**` : "", thought.description ?? ""]
            .filter(Boolean)
            .join("\n")
        )
        .filter(Boolean)
        .join("\n\n");
      if (thoughts) {
        events.push({
          eventId: randomUUID(),
          conversationId,
          kind: "reasoning",
          messageId,
          text: thoughts,
          createdAt,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        if (!toolCall.name) {
          continue;
        }
        const inputDetail = clampDetail(summarizeToolInput(toolCall.args));
        const outputDetail = clampDetail(
          extractToolOutputText(toolCall.resultDisplay ?? toolCall.output ?? toolCall.result)
        );
        const detail = [inputDetail, outputDetail]
          .filter(Boolean)
          .join(inputDetail && outputDetail ? "\n\n--- Output ---\n\n" : "");
        events.push({
          eventId: randomUUID(),
          conversationId,
          kind: "tool_call",
          toolCallId: toolCall.id ?? randomUUID(),
          title: toolCall.name,
          toolKind: inferToolKind(toolCall.name),
          status: toolCall.status === "error" ? "failed" : "completed",
          ...(detail ? { detail } : {}),
          createdAt,
        });
      }
      const text = partText(message.content);
      if (text.trim()) {
        events.push(
          {
            eventId: randomUUID(),
            conversationId,
            kind: "assistant_message_chunk",
            messageId,
            text,
            createdAt,
          },
          {
            eventId: messageId,
            conversationId,
            kind: "assistant_message_end",
            messageId,
            stopReason: "end_turn",
            createdAt: createdAt + 1,
          }
        );
      }
      continue;
    }
    if (message.type === "info" || message.type === "warning" || message.type === "error") {
      const text = partText(message.content);
      if (!text.trim()) {
        continue;
      }
      events.push({
        eventId: messageId,
        conversationId,
        kind: "system",
        level: message.type === "error" ? "error" : message.type === "warning" ? "warning" : "info",
        text,
        createdAt,
      });
    }
  }
  return events;
}

export function createGeminiImportSource(): HarnessImportSource {
  const locateFile = async (sessionId: string): Promise<string | null> => {
    const shortId = sessionId.slice(0, 8);
    const files = await listConversationFiles();
    const matches = files.filter(
      (file) => file.endsWith(`-${shortId}.jsonl`) || file.endsWith(`-${shortId}.json`)
    );
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
  };

  return {
    harnessKey: "gemini",
    backendIds: ["google-antigravity-cli"],
    displayName: "Gemini CLI / Antigravity",

    async detect(): Promise<HarnessImportAvailability> {
      const root = geminiTmpRoot();
      if (await pathExists(root)) {
        return { available: true, storageRoot: root };
      }
      return {
        available: false,
        reason: "No Gemini CLI chats found (~/.gemini/tmp does not exist).",
        storageRoot: root,
      };
    },

    async listSessions(): Promise<HarnessSessionSummary[]> {
      const files = await listConversationFiles();
      const summaries: HarnessSessionSummary[] = [];
      for (const file of files) {
        const conversation = await readConversationFile(file);
        if (!conversation?.sessionId) {
          continue;
        }
        let statMtime: number | null = null;
        try {
          statMtime = (await fs.stat(file)).mtimeMs;
        } catch {
          // ignore
        }
        summaries.push(summarizeConversation(conversation, file, conversation.sessionId, statMtime));
      }
      return summaries.sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
      );
    },

    async readSession(sessionId: string): Promise<HarnessSessionTranscript> {
      const file = await locateFile(sessionId);
      if (!file) {
        throw new Error(`Gemini CLI session not found: ${sessionId}`);
      }
      const conversation = await readConversationFile(file);
      if (!conversation?.sessionId) {
        throw new Error(`Could not parse Gemini CLI session: ${sessionId}`);
      }
      let statMtime: number | null = null;
      try {
        statMtime = (await fs.stat(file)).mtimeMs;
      } catch {
        // ignore
      }
      const summary = summarizeConversation(conversation, file, conversation.sessionId, statMtime);
      const events = mapGeminiMessagesToEvents(conversation.messages, "");
      const startTs = toEpochMs(conversation.startTime);
      return {
        summary,
        events,
        ...(startTs ? { startedAt: new Date(startTs).toISOString() } : {}),
      };
    },

    async prepareNativeResume(sessionId: string, workspaceRoot: string): Promise<string> {
      const source = await locateFile(sessionId);
      if (!source) {
        return sessionId;
      }
      const targetDir = geminiChatsDirForCwd(workspaceRoot);
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
      return sessionId;
    },
  };
}
