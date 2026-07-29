import { promises as fs } from "node:fs";
import path from "node:path";

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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

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

/** Compact single-line preview of structured tool input for event details. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) {
    return undefined;
  }
  if (typeof input === "string") {
    return input;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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
