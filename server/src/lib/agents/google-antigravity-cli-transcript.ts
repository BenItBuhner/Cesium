import { open, stat } from "node:fs/promises";
import type { GoogleAntigravityEvent } from "./google-antigravity-cli-session.js";

export type GoogleAntigravityTranscriptRecord = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class GoogleAntigravityTranscriptTailer {
  private offset = 0;
  private closed = false;

  constructor(private readonly transcriptPath: string) {}

  close(): void {
    this.closed = true;
  }

  async poll(): Promise<GoogleAntigravityEvent[]> {
    if (this.closed) {
      return [];
    }
    const fileStat = await stat(this.transcriptPath).catch(() => undefined);
    if (!fileStat || fileStat.size <= this.offset) {
      return [];
    }

    const file = await open(this.transcriptPath, "r");
    try {
      const length = fileStat.size - this.offset;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, this.offset);
      this.offset = fileStat.size;
      return parseGoogleAntigravityTranscriptChunk(buffer.toString("utf8"));
    } finally {
      await file.close();
    }
  }
}

export function parseGoogleAntigravityTranscriptChunk(
  chunk: string
): GoogleAntigravityEvent[] {
  const events: GoogleAntigravityEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record: GoogleAntigravityTranscriptRecord | undefined;
    try {
      record = JSON.parse(line) as GoogleAntigravityTranscriptRecord;
    } catch {
      record = undefined;
    }
    if (!record) {
      continue;
    }
    events.push(...transcriptRecordToGoogleAntigravityEvents(record));
  }
  return events;
}

export function transcriptRecordToGoogleAntigravityEvents(
  record: GoogleAntigravityTranscriptRecord
): GoogleAntigravityEvent[] {
  const at = record.created_at ?? nowIso();
  const content = typeof record.content === "string" ? record.content : "";
  const type = typeof record.type === "string" ? record.type : "";
  const source = typeof record.source === "string" ? record.source : "";
  const stepIdx = typeof record.step_index === "number" ? record.step_index : -1;
  const events: GoogleAntigravityEvent[] = [];

  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    events.push({
      type: "tool.proposed",
      sessionId: "transcript",
      toolName: typeof call.name === "string" ? call.name : "unknown",
      args: isRecord(call.args) ? call.args : {},
      stepIdx,
      at,
    });
  }

  if (source === "MODEL" && content && /RESPONSE|ANSWER|PLANNER|THOUGHT/i.test(type)) {
    events.push({
      type: /THOUGHT/i.test(type) ? "thought.delta" : "text.delta",
      sessionId: "transcript",
      text: content,
      at,
    });
  }

  if (isToolResultType(type)) {
    events.push({ type: "tool.finished", sessionId: "transcript", stepIdx, at });
  }

  const artifactPath = findArtifactPath(content);
  if (artifactPath) {
    events.push({ type: "artifact.created", sessionId: "transcript", path: artifactPath, at });
  }

  return events;
}

function findArtifactPath(content: string): string | undefined {
  const match = content.match(
    /(?:artifact|saved|wrote|created).*?((?:[A-Za-z]:)?[/\\][^\s'"`]+(?:\.md|\.json|\.txt|\.png|\.jpg|\.webm))/i
  );
  return match?.[1];
}

function isToolResultType(type: string): boolean {
  return [
    "LIST_DIRECTORY",
    "VIEW_FILE",
    "WRITE_TO_FILE",
    "REPLACE_FILE_CONTENT",
    "MULTI_REPLACE_FILE_CONTENT",
    "GREP_SEARCH",
    "RUN_COMMAND",
    "WEB_SEARCH",
    "READ_URL_CONTENT",
  ].includes(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
