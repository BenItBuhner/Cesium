import { promises as fs } from "node:fs";
import path from "node:path";
import { asRecord } from "../../coerce.js";

/** Parse a JSONL file tolerantly: blank/garbled lines are skipped. */
export async function readJsonLines(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Tolerate partial tail writes from a live session file.
    }
  }
  return out;
}

export { asNumber, asRecord } from "../../coerce.js";

/** Any string, including empty ones (transcript readers preserve blank fields). */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse ISO timestamps (or epoch ms) into epoch ms; null when unparsable. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function truncateTitle(text: string, max = 72): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1)}…`;
}

export { pathExists } from "../../persistence.js";

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Dedupe session summaries by native id. Re-homed copies of the same session
 * exist in several storage dirs after import; keep the furthest-along one
 * (highest updatedAt, then highest messageCount).
 */
export function dedupeSessionsByLatest<T extends { id: string; updatedAt: number | null; messageCount: number }>(
  sessions: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    if (
      !existing ||
      (session.updatedAt ?? 0) > (existing.updatedAt ?? 0) ||
      ((session.updatedAt ?? 0) === (existing.updatedAt ?? 0) &&
        session.messageCount > existing.messageCount)
    ) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()];
}

/** Map a harness tool name onto the closest Cesium toolKind. */
export function inferToolKind(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/^(read|view|openfile|cat)\b/.test(name)) return "read";
  if (/^(write|create|edit|multiedit|notebookedit|apply_patch|patch|replace)/.test(name)) return "edit";
  if (/^(bash|shell|terminal|run|exec|cmd|command|local_shell)/.test(name)) return "execute";
  if (/^(grep|search|find|glob|ripgrep|rg|list|ls|todoread)/.test(name)) return "search";
  if (/^(websearch|webfetch|web|fetch|browser|searchweb)/.test(name)) return "fetch";
  if (/^(task|agent|subagent|spawn)/.test(name)) return "think";
  if (/^(todowrite|update_plan|plan)/.test(name)) return "think";
  return "other";
}
/** Extract readable text out of a tool result/output payload. */
export function extractToolOutputText(output: unknown): string | undefined {
  if (output == null) {
    return undefined;
  }
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    const parts = output
      .map((item) => {
        const rec = asRecord(item);
        if (!rec) return typeof item === "string" ? item : "";
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.content === "string") return rec.content;
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n");
    }
    return undefined;
  }
  const rec = asRecord(output);
  if (rec) {
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.content === "string") return rec.content;
    if (typeof rec.output === "string") return rec.output;
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

/** Truncate very large tool payloads so imports stay snappy to render. */
export function clampDetail(text: string | undefined, max = 20000): string | undefined {
  if (!text) {
    return undefined;
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars on import]`;
}
