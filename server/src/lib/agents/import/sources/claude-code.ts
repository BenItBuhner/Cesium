import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEventInput } from "../../types.js";
import type {
  HarnessImportAvailability,
  HarnessImportSource,
  HarnessSessionSummary,
  HarnessSessionTranscript,
} from "../types.js";
import {
  dedupeSessionsByLatest,
  listFilesRecursive,
  pathExists,
  readJsonLines,
  toEpochMs,
  truncateTitle,
} from "../reader-utils.js";
import { importedToolCallEvent, importedToolResultEvent } from "../tool-events.js";

/**
 * Claude Code stores one JSONL transcript per session:
 *   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 * Entries: user / assistant / attachment / queue-operation / summary /
 * ai-title / last-prompt. Assistant messages carry Anthropic content blocks
 * (text | thinking | tool_use); tool results arrive as tool_result blocks
 * inside following user entries.
 */

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

export function claudeProjectsRoot(): string {
  return path.join(claudeRoot(), "projects");
}

/** Claude derives its per-project dir by replacing every non [a-zA-Z0-9-] char with "-". */
export function claudeProjectSlugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** True when Claude's own session file exists for the given cwd - resume will work natively. */
export async function claudeSessionFileExistsForCwd(
  sessionId: string,
  cwd: string
): Promise<boolean> {
  return pathExists(
    path.join(claudeProjectsRoot(), claudeProjectSlugForCwd(cwd), `${sessionId}.jsonl`)
  );
}

type ClaudeEntry = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  summary?: string;
  aiTitle?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
  };
};

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function contentBlocks(content: unknown): ClaudeContentBlock[] {
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

/**
 * Copy a session artifact into its re-homed location without ever clobbering
 * a same-age-or-newer target: after import the harness may keep writing to the
 * re-homed file, making it authoritative over the original source.
 */
async function copyFileIfStaleTarget(source: string, target: string): Promise<void> {
  try {
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(source),
      fs.stat(target).catch(() => null),
    ]);
    if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) {
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } catch (error) {
    console.warn(
      `[agent-import] failed to re-home ${source} -> ${target}:`,
      error instanceof Error ? error.message : error
    );
  }
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  const root = claudeProjectsRoot();
  const fileName = `${sessionId}.jsonl`;
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return null;
  }
  // A session can exist in several project dirs after re-homing - the
  // furthest-along copy is authoritative (mtime first; append-only growth
  // via size as the tie-break for equal/reset timestamps).
  let best: { file: string; mtimeMs: number; size: number } | null = null;
  for (const dir of projectDirs) {
    const candidate = path.join(dir, fileName);
    try {
      const stat = await fs.stat(candidate);
      if (
        !best ||
        stat.mtimeMs > best.mtimeMs ||
        (stat.mtimeMs === best.mtimeMs && stat.size > best.size)
      ) {
        best = { file: candidate, mtimeMs: stat.mtimeMs, size: stat.size };
      }
    } catch {
      // not in this project dir
    }
  }
  return best?.file ?? null;
}

function summarizeEntries(entries: ClaudeEntry[], sourcePath: string, sessionId: string, statMtime: number | null): HarnessSessionSummary {
  let title: string | undefined;
  let preview: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  let messageCount = 0;

  for (const entry of entries) {
    if (entry.type === "summary" && entry.summary?.trim() && !title) {
      title = truncateTitle(entry.summary);
    }
    if (entry.type === "ai-title" && entry.aiTitle?.trim() && !title) {
      title = truncateTitle(entry.aiTitle);
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) {
      continue;
    }
    cwd = cwd ?? entry.cwd;
    const ts = toEpochMs(entry.timestamp);
    if (ts !== null) {
      createdAt = createdAt === null ? ts : Math.min(createdAt, ts);
      updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
    }
    if (entry.type === "user") {
      const content = entry.message?.content;
      if (typeof content === "string" && content.trim()) {
        messageCount += 1;
        if (!preview) {
          preview = truncateTitle(content, 120);
        }
      } else {
        const blocks = contentBlocks(content);
        const text = blocks
          .filter((block) => block.type === "text" && block.text?.trim())
          .map((block) => block.text!.trim())
          .join("\n");
        if (text) {
          messageCount += 1;
          if (!preview) {
            preview = truncateTitle(text, 120);
          }
        }
      }
    } else if (entry.type === "assistant") {
      const hasVisible = contentBlocks(entry.message?.content).some(
        (block) => (block.type === "text" && block.text?.trim()) || block.type === "tool_use"
      );
      if (hasVisible) {
        messageCount += 1;
      }
    }
  }

  return {
    id: sessionId,
    title: title ?? preview ?? `Claude session ${sessionId.slice(0, 8)}`,
    ...(cwd ? { cwd } : {}),
    createdAt,
    updatedAt: updatedAt ?? statMtime,
    messageCount,
    sourcePath,
    ...(preview ? { preview } : {}),
  };
}

export function mapClaudeEntriesToEvents(
  entries: ClaudeEntry[],
  conversationId: string
): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  let lastTs: number | null = null;
  const nextTime = (entry: ClaudeEntry): number => {
    const ts = toEpochMs(entry.timestamp);
    if (ts !== null) {
      lastTs = lastTs === null ? ts : Math.max(ts, lastTs + 1);
      return lastTs;
    }
    lastTs = (lastTs ?? Date.now()) + 1;
    return lastTs;
  };
  /** tool_use id -> original call payload, so results can update the same card. */
  const toolInfoByToolUseId = new Map<string, { name: string; input: unknown }>();

  for (const entry of entries) {
    if (entry.isSidechain || entry.isMeta) {
      continue;
    }
    if (entry.type === "user") {
      const content = entry.message?.content;
      if (typeof content === "string") {
        if (!content.trim()) {
          continue;
        }
        events.push({
          eventId: entry.uuid ?? randomUUID(),
          conversationId,
          kind: "user_message",
          messageId: entry.uuid ?? randomUUID(),
          content,
          createdAt: nextTime(entry),
        });
        continue;
      }
      const blocks = contentBlocks(content);
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          textParts.push(block.text);
        } else if (block.type === "tool_result" && block.tool_use_id) {
          const info = toolInfoByToolUseId.get(block.tool_use_id);
          if (info) {
            events.push(
              importedToolResultEvent({
                conversationId,
                toolCallId: block.tool_use_id,
                name: info.name,
                toolInput: info.input,
                // Claude keeps a structured result (stdout, file info…) on the
                // entry itself; the block content is the plain-text fallback.
                result: entry.toolUseResult ?? block.content,
                isError: block.is_error === true,
                createdAt: nextTime(entry),
              })
            );
          }
        }
      }
      if (textParts.length > 0) {
        events.push({
          eventId: entry.uuid ?? randomUUID(),
          conversationId,
          kind: "user_message",
          messageId: entry.uuid ?? randomUUID(),
          content: textParts.join("\n"),
          createdAt: nextTime(entry),
        });
      }
      continue;
    }

    if (entry.type === "assistant") {
      const messageId = entry.message?.id ?? entry.uuid ?? randomUUID();
      const createdAt = nextTime(entry);
      const blocks = contentBlocks(entry.message?.content);
      const text = blocks
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!)
        .join("");
      const thinking = blocks
        .filter((block) => (block.type === "thinking" || block.type === "redacted_thinking") && block.thinking)
        .map((block) => block.thinking!)
        .join("\n\n");
      if (thinking.trim()) {
        events.push({
          eventId: randomUUID(),
          conversationId,
          kind: "reasoning",
          messageId,
          text: thinking,
          createdAt,
        });
      }
      for (const block of blocks) {
        if (block.type !== "tool_use" || !block.name) {
          continue;
        }
        const toolCallId = block.id ?? randomUUID();
        toolInfoByToolUseId.set(toolCallId, { name: block.name, input: block.input });
        events.push(
          importedToolCallEvent({
            conversationId,
            toolCallId,
            name: block.name,
            toolInput: block.input,
            createdAt,
          })
        );
      }
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
            ...(entry.message?.model ? { stopReason: "end_turn" } : {}),
            createdAt: createdAt + 1,
          }
        );
      }
    }
  }
  return events;
}

export function createClaudeCodeImportSource(): HarnessImportSource {
  return {
    harnessKey: "claude-code",
    backendIds: ["claude-code-sdk"],
    displayName: "Claude Code",

    async detect(): Promise<HarnessImportAvailability> {
      const root = claudeProjectsRoot();
      if (await pathExists(root)) {
        return { available: true, storageRoot: root };
      }
      return {
        available: false,
        reason: "No Claude Code projects found (~/.claude/projects does not exist).",
        storageRoot: root,
      };
    },

    async listSessions(): Promise<HarnessSessionSummary[]> {
      const root = claudeProjectsRoot();
      const files = (await listFilesRecursive(root)).filter((file) => file.endsWith(".jsonl"));
      const summaries: HarnessSessionSummary[] = [];
      for (const file of files) {
        const sessionId = path.basename(file, ".jsonl");
        let statMtime: number | null = null;
        try {
          statMtime = (await fs.stat(file)).mtimeMs;
        } catch {
          // ignore
        }
        const entries = (await readJsonLines(file)) as ClaudeEntry[];
        if (entries.length === 0) {
          continue;
        }
        summaries.push(summarizeEntries(entries, file, sessionId, statMtime));
      }
      return dedupeSessionsByLatest(summaries).sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
      );
    },

    async readSession(sessionId: string): Promise<HarnessSessionTranscript> {
      const file = await findSessionFile(sessionId);
      if (!file) {
        throw new Error(`Claude Code session not found: ${sessionId}`);
      }
      const entries = (await readJsonLines(file)) as ClaudeEntry[];
      let statMtime: number | null = null;
      try {
        statMtime = (await fs.stat(file)).mtimeMs;
      } catch {
        // ignore
      }
      const summary = summarizeEntries(entries, file, sessionId, statMtime);
      const events = mapClaudeEntriesToEvents(entries, "");
      const firstTs = events.find((event) => typeof event.createdAt === "number")?.createdAt;
      return {
        summary,
        events,
        ...(firstTs ? { startedAt: new Date(firstTs).toISOString() } : {}),
      };
    },

    async prepareNativeResume(sessionId: string, workspaceRoot: string): Promise<string> {
      const source = await findSessionFile(sessionId);
      if (!source) {
        return sessionId;
      }
      const targetDir = path.join(claudeProjectsRoot(), claudeProjectSlugForCwd(workspaceRoot));
      const target = path.join(targetDir, path.basename(source));
      if (path.resolve(source) !== path.resolve(target)) {
        await copyFileIfStaleTarget(source, target);
      }
      return sessionId;
    },
  };
}
