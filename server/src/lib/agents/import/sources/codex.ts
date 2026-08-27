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
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  readJsonLines,
  toEpochMs,
  truncateTitle,
} from "../reader-utils.js";
import { importedToolCallEvent, importedToolResultEvent } from "../tool-events.js";

/**
 * Codex CLI stores one rollout file per thread:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
 * (archived threads live in ~/.codex/archived_sessions/ with the same layout).
 * Records: session_meta, turn_context, world_state, response_item (message /
 * reasoning / function_call / function_call_output / local_shell_call /
 * custom_tool_call ...) and event_msg (user_message / agent_message /
 * token_count / task_started / task_complete).
 */

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function codexStorageRoots(): string[] {
  const home = codexHome();
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

type CodexRecord = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type CodexContentItem = { type?: string; text?: string };

function contentText(content: unknown, textTypes: string[]): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return (content as CodexContentItem[])
    .filter((item) => item && textTypes.includes(item.type ?? "") && typeof item.text === "string")
    .map((item) => item.text!)
    .join("");
}

/** True for harness-injected scaffolding messages that never render in the Codex UI. */
function isInternalCodexUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<user_instructions>")
  );
}

async function findRolloutFile(sessionId: string): Promise<string | null> {
  for (const root of codexStorageRoots()) {
    const files = (await listFilesRecursive(root)).filter(
      (file) =>
        path.basename(file).startsWith("rollout-") &&
        file.endsWith(".jsonl") &&
        file.includes(sessionId)
    );
    if (files.length > 0) {
      return files[0]!;
    }
  }
  return null;
}

async function listRolloutFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const root of codexStorageRoots()) {
    out.push(
      ...(await listFilesRecursive(root)).filter(
        (file) => path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl")
      )
    );
  }
  return out;
}

function summarizeRecords(
  records: CodexRecord[],
  sourcePath: string,
  sessionId: string,
  cwd: string | undefined,
  startTs: number | null,
  statMtime: number | null
): HarnessSessionSummary {
  let firstUserText: string | undefined;
  let updatedAt: number | null = null;
  let messageCount = 0;

  for (const record of records) {
    if (record.type !== "response_item") {
      continue;
    }
    const payload = record.payload;
    if (!payload || payload.type !== "message") {
      continue;
    }
    const role = asString(payload.role);
    if (role === "user") {
      const text = contentText(payload.content, ["input_text"]);
      if (!text.trim() || isInternalCodexUserText(text)) {
        continue;
      }
      messageCount += 1;
      if (!firstUserText) {
        firstUserText = text;
      }
      const ts = toEpochMs(record.timestamp);
      if (ts !== null) {
        updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
      }
    } else if (role === "assistant") {
      const text = contentText(payload.content, ["output_text"]);
      if (!text.trim()) {
        continue;
      }
      messageCount += 1;
      const ts = toEpochMs(record.timestamp);
      if (ts !== null) {
        updatedAt = updatedAt === null ? ts : Math.max(updatedAt, ts);
      }
    }
  }

  return {
    id: sessionId,
    title: firstUserText ? truncateTitle(firstUserText) : `Codex thread ${sessionId.slice(0, 8)}`,
    ...(cwd ? { cwd } : {}),
    createdAt: startTs,
    updatedAt: updatedAt ?? statMtime,
    messageCount,
    sourcePath,
    ...(firstUserText ? { preview: truncateTitle(firstUserText, 120) } : {}),
  };
}

async function readRollout(file: string): Promise<{ records: CodexRecord[]; sessionId: string; cwd?: string; startTs: number | null }> {
  const records = (await readJsonLines(file)) as CodexRecord[];
  const meta = asRecord(records.find((record) => record.type === "session_meta")?.payload);
  const sessionId =
    asString(meta?.id) ?? asString(meta?.session_id) ?? path.basename(file, ".jsonl").replace(/^rollout-[^0-9a-f]*-?/i, "");
  const cwd = asString(meta?.cwd);
  const startTs = toEpochMs(meta?.timestamp) ?? toEpochMs(records[0]?.timestamp);
  return { records, sessionId, ...(cwd ? { cwd } : {}), startTs };
}

export function mapCodexRecordsToEvents(
  records: CodexRecord[],
  conversationId: string
): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  let lastTs: number | null = null;
  const nextTime = (record: CodexRecord): number => {
    const ts = toEpochMs(record.timestamp);
    if (ts !== null) {
      lastTs = lastTs === null ? ts : Math.max(ts, lastTs + 1);
      return lastTs;
    }
    lastTs = (lastTs ?? Date.now()) + 1;
    return lastTs;
  };
  /** call_id -> original call payload, for output updates. */
  const toolInfoByCallId = new Map<string, { name: string; input: unknown }>();
  /** Codex ships arguments as JSON strings, `cmd` keys, and argv arrays. */
  const parseToolInput = (raw: unknown): unknown => {
    let value = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return raw;
      }
    }
    const record = asRecord(value);
    if (!record) {
      return value;
    }
    const command = Array.isArray(record.command)
      ? record.command.map((part) => String(part)).join(" ")
      : asString(record.command) ?? asString(record.cmd);
    return command ? { ...record, command } : value;
  };
  /** Codex exec tools carry opaque names; classify them as terminal commands. */
  const canonicalToolName = (name: string): string =>
    /^(exec|shell|local_shell|unified_exec|container\.exec)/i.test(name) ? "shell" : name;

  for (const record of records) {
    if (record.type !== "response_item") {
      continue;
    }
    const payload = record.payload;
    if (!payload) {
      continue;
    }
    const payloadType = asString(payload.type);
    const createdAt = nextTime(record);

    if (payloadType === "message") {
      const role = asString(payload.role);
      const messageId = asString(payload.id) ?? randomUUID();
      if (role === "user") {
        const text = contentText(payload.content, ["input_text"]);
        if (!text.trim() || isInternalCodexUserText(text)) {
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
      } else if (role === "assistant") {
        const text = contentText(payload.content, ["output_text"]);
        if (!text.trim()) {
          continue;
        }
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

    if (payloadType === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? (payload.summary as CodexContentItem[])
            .filter((item) => item && typeof item.text === "string")
            .map((item) => item.text!)
            .join("\n\n")
        : "";
      const content = contentText(payload.content, ["reasoning_text", "text"]);
      const text = (summary || content).trim();
      if (!text) {
        continue;
      }
      events.push({
        eventId: asString(payload.id) ?? randomUUID(),
        conversationId,
        kind: "reasoning",
        messageId: asString(payload.id) ?? randomUUID(),
        text,
        createdAt,
      });
      continue;
    }

    if (
      payloadType === "function_call" ||
      payloadType === "local_shell_call" ||
      payloadType === "custom_tool_call"
    ) {
      const name = canonicalToolName(
        asString(payload.name) ?? (payloadType === "local_shell_call" ? "shell" : "tool")
      );
      const callId =
        asString(payload.call_id) ?? asString(payload.callId) ?? asString(payload.id) ?? randomUUID();
      const rawInput =
        payloadType === "local_shell_call"
          ? parseToolInput(payload.action)
          : parseToolInput(asString(payload.arguments) ?? payload.input ?? payload.arguments);
      toolInfoByCallId.set(callId, { name, input: rawInput });
      events.push(
        importedToolCallEvent({
          conversationId,
          toolCallId: callId,
          name,
          toolInput: rawInput,
          createdAt,
        })
      );
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = asString(payload.call_id) ?? asString(payload.callId);
      if (!callId) {
        continue;
      }
      const info = toolInfoByCallId.get(callId);
      if (info) {
        // Shell outputs are JSON-encoded strings ({"output": "...", "metadata": …}).
        let result = payload.output;
        if (typeof result === "string") {
          try {
            const parsed: unknown = JSON.parse(result);
            if (parsed && typeof parsed === "object") {
              result = parsed as Record<string, unknown>;
            }
          } catch {
            // plain-text output - keep as-is
          }
        }
        events.push(
          importedToolResultEvent({
            conversationId,
            toolCallId: callId,
            name: info.name,
            toolInput: info.input,
            result,
            createdAt,
          })
        );
      }
    }
  }
  return events;
}

export function createCodexImportSource(): HarnessImportSource {
  return {
    harnessKey: "codex",
    backendIds: ["codex-app-server", "codex-acp"],
    displayName: "Codex",

    async detect(): Promise<HarnessImportAvailability> {
      const root = path.join(codexHome(), "sessions");
      if (await pathExists(root)) {
        return { available: true, storageRoot: root };
      }
      return {
        available: false,
        reason: "No Codex sessions found (~/.codex/sessions does not exist).",
        storageRoot: root,
      };
    },

    async listSessions(): Promise<HarnessSessionSummary[]> {
      const files = await listRolloutFiles();
      const summaries: HarnessSessionSummary[] = [];
      for (const file of files) {
        let statMtime: number | null = null;
        try {
          statMtime = (await fs.stat(file)).mtimeMs;
        } catch {
          // ignore
        }
        try {
          const { records, sessionId, cwd, startTs } = await readRollout(file);
          summaries.push(summarizeRecords(records, file, sessionId, cwd, startTs, statMtime));
        } catch {
          // Skip unreadable rollouts.
        }
      }
      return summaries.sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
      );
    },

    async readSession(sessionId: string): Promise<HarnessSessionTranscript> {
      const file = await findRolloutFile(sessionId);
      if (!file) {
        throw new Error(`Codex thread not found: ${sessionId}`);
      }
      let statMtime: number | null = null;
      try {
        statMtime = (await fs.stat(file)).mtimeMs;
      } catch {
        // ignore
      }
      const { records, sessionId: resolvedId, cwd, startTs } = await readRollout(file);
      const summary = summarizeRecords(records, file, resolvedId, cwd, startTs, statMtime);
      const events = mapCodexRecordsToEvents(records, "");
      return {
        summary,
        events,
        ...(startTs ? { startedAt: new Date(startTs).toISOString() } : {}),
      };
    },

    // Codex rollout storage is global (~/.codex/sessions) and `thread/resume`
    // resolves by thread id regardless of cwd - no re-homing required.
  };
}
