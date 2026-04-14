import type { AgentToolEditPreview, AgentToolEditPreviewLine } from "./types.js";

const MAX_EDIT_PREVIEW_TEXT_CHARS = 80_000;
const MAX_EDIT_PREVIEW_LINES = 140;
const MAX_DIFF_MATRIX_CELLS = 40_000;
const CONTEXT_RADIUS = 2;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function splitLines(value: string): string[] {
  return normalizeText(value).split("\n");
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function firstStringIncludingEmpty(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function unwrapEditPayload(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asRecord(record.success) ?? asRecord(record.output) ?? record;
}

function pathFromRecords(...records: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const record of records) {
    const value = firstString(record, [
      "path",
      "filePath",
      "file_path",
      "targetPath",
      "target_path",
      "target_file",
      "relativePath",
      "relative_path",
      "relPath",
      "newPath",
      "new_path",
      "renameTo",
      "rename_to",
      "file",
      "uri",
      "to",
      "from",
    ]);
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

type DiffLine = AgentToolEditPreviewLine;

function pushContextRange(
  out: DiffLine[],
  lines: readonly string[],
  startLineNumber: number,
  startIndex: number,
  endIndexExclusive: number
): void {
  for (let index = startIndex; index < endIndexExclusive; index += 1) {
    out.push({
      kind: "context",
      text: lines[index] ?? "",
      oldLineNumber: startLineNumber + index,
      newLineNumber: startLineNumber + index,
    });
  }
}

function diffMiddleWithLcs(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  beforeStartLine: number,
  afterStartLine: number
): DiffLine[] {
  const beforeCount = beforeLines.length;
  const afterCount = afterLines.length;
  const table = Array.from({ length: beforeCount + 1 }, () => Array<number>(afterCount + 1).fill(0));

  for (let i = beforeCount - 1; i >= 0; i -= 1) {
    for (let j = afterCount - 1; j >= 0; j -= 1) {
      table[i]![j] =
        beforeLines[i] === afterLines[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let oldLine = beforeStartLine;
  let newLine = afterStartLine;
  while (beforeIndex < beforeCount && afterIndex < afterCount) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      out.push({
        kind: "context",
        text: beforeLines[beforeIndex] ?? "",
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      beforeIndex += 1;
      afterIndex += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if ((table[beforeIndex + 1]![afterIndex] ?? 0) >= (table[beforeIndex]![afterIndex + 1] ?? 0)) {
      out.push({
        kind: "remove",
        text: beforeLines[beforeIndex] ?? "",
        oldLineNumber: oldLine,
      });
      beforeIndex += 1;
      oldLine += 1;
      continue;
    }
    out.push({
      kind: "add",
      text: afterLines[afterIndex] ?? "",
      newLineNumber: newLine,
    });
    afterIndex += 1;
    newLine += 1;
  }

  while (beforeIndex < beforeCount) {
    out.push({
      kind: "remove",
      text: beforeLines[beforeIndex] ?? "",
      oldLineNumber: oldLine,
    });
    beforeIndex += 1;
    oldLine += 1;
  }
  while (afterIndex < afterCount) {
    out.push({
      kind: "add",
      text: afterLines[afterIndex] ?? "",
      newLineNumber: newLine,
    });
    afterIndex += 1;
    newLine += 1;
  }
  return out;
}

function collapseContextRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== "context") {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < lines.length && lines[index]?.kind === "context") {
      index += 1;
    }
    const run = lines.slice(runStart, index);
    const hasChangeBefore = out.length > 0 && out[out.length - 1]?.kind !== "gap";
    const hasChangeAfter = index < lines.length;
    if (run.length <= CONTEXT_RADIUS * 2 || (!hasChangeBefore && !hasChangeAfter)) {
      out.push(...run);
      continue;
    }
    if (!hasChangeBefore) {
      out.push(...run.slice(-CONTEXT_RADIUS));
      continue;
    }
    if (!hasChangeAfter) {
      out.push(...run.slice(0, CONTEXT_RADIUS));
      continue;
    }
    out.push(...run.slice(0, CONTEXT_RADIUS));
    out.push({
      kind: "gap",
      text: `${run.length - CONTEXT_RADIUS * 2} unchanged line${run.length - CONTEXT_RADIUS * 2 === 1 ? "" : "s"}`,
    });
    out.push(...run.slice(-CONTEXT_RADIUS));
  }
  return out;
}

function diffTextPair(beforeText: string, afterText: string): {
  lines: DiffLine[];
  truncated: boolean;
} {
  const before = normalizeText(beforeText);
  const after = normalizeText(afterText);
  const truncated = before.length + after.length > MAX_EDIT_PREVIEW_TEXT_CHARS;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const out: DiffLine[] = [];
  const prefixStart = Math.max(0, prefix - CONTEXT_RADIUS);
  pushContextRange(out, beforeLines, 1, prefixStart, prefix);

  const beforeMiddle = beforeLines.slice(prefix, beforeSuffix + 1);
  const afterMiddle = afterLines.slice(prefix, afterSuffix + 1);
  const cellCount = beforeMiddle.length * afterMiddle.length;
  const middle =
    cellCount > 0 && cellCount <= MAX_DIFF_MATRIX_CELLS
      ? diffMiddleWithLcs(beforeMiddle, afterMiddle, prefix + 1, prefix + 1)
      : [
          ...beforeMiddle.map((text, idx) => ({
            kind: "remove" as const,
            text,
            oldLineNumber: prefix + idx + 1,
          })),
          ...afterMiddle.map((text, idx) => ({
            kind: "add" as const,
            text,
            newLineNumber: prefix + idx + 1,
          })),
        ];
  out.push(...collapseContextRuns(middle));

  const suffixCount = beforeLines.length - (beforeSuffix + 1);
  if (suffixCount > 0) {
    const suffixKeep = Math.min(CONTEXT_RADIUS, suffixCount);
    const beforeSuffixStart = beforeLines.length - suffixCount;
    const afterSuffixStart = afterLines.length - suffixCount;
    const offset = suffixCount - suffixKeep;
    for (let idx = 0; idx < suffixKeep; idx += 1) {
      out.push({
        kind: "context",
        text: beforeLines[beforeSuffixStart + offset + idx] ?? "",
        oldLineNumber: beforeSuffixStart + offset + idx + 1,
        newLineNumber: afterSuffixStart + offset + idx + 1,
      });
    }
  }

  const limited = out.length > MAX_EDIT_PREVIEW_LINES ? out.slice(0, MAX_EDIT_PREVIEW_LINES) : out;
  return {
    lines: limited,
    truncated: truncated || out.length > limited.length || cellCount > MAX_DIFF_MATRIX_CELLS,
  };
}

function parseUnifiedPatch(patchText: string): { lines: DiffLine[]; truncated: boolean } | undefined {
  const lines = normalizeText(patchText).split("\n");
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      if (out.length > 0) {
        out.push({ kind: "gap", text: "..." });
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) {
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), newLineNumber: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ kind: "remove", text: line.slice(1), oldLineNumber: oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      out.push({
        kind: "context",
        text: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (out.length === 0) {
    return undefined;
  }
  const limited = out.length > MAX_EDIT_PREVIEW_LINES ? out.slice(0, MAX_EDIT_PREVIEW_LINES) : out;
  return {
    lines: limited,
    truncated: out.length > limited.length,
  };
}

function buildPreview(
  source: AgentToolEditPreview["source"],
  path: string | undefined,
  lines: DiffLine[],
  truncated: boolean
): AgentToolEditPreview | undefined {
  const filtered = lines.filter((line) => line.kind === "add" || line.kind === "remove");
  if (filtered.length === 0) {
    return undefined;
  }
  return {
    path,
    source,
    addedLines: filtered.filter((line) => line.kind === "add").length,
    removedLines: filtered.filter((line) => line.kind === "remove").length,
    truncated,
    lines,
  };
}

function previewFromPatch(
  patchText: string,
  path: string | undefined
): AgentToolEditPreview | undefined {
  const parsed = parseUnifiedPatch(patchText);
  if (!parsed) {
    return undefined;
  }
  return buildPreview("patch", path, parsed.lines, parsed.truncated);
}

function previewFromBeforeAfter(
  beforeText: string,
  afterText: string,
  path: string | undefined,
  source: AgentToolEditPreview["source"]
): AgentToolEditPreview | undefined {
  const diff = diffTextPair(beforeText, afterText);
  return buildPreview(source, path, diff.lines, diff.truncated);
}

function previewFromEdits(
  edits: unknown,
  path: string | undefined
): AgentToolEditPreview | undefined {
  if (!Array.isArray(edits)) {
    return undefined;
  }
  for (const entry of edits) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const before =
      firstString(record, ["old_string", "oldString", "before", "beforeText"]) ??
      undefined;
    const after =
      firstString(record, ["new_string", "newString", "after", "afterText", "replacement"]) ??
      undefined;
    if (before != null && after != null) {
      return previewFromBeforeAfter(before, after, pathFromRecords(record) ?? path, "replace");
    }
  }
  return undefined;
}

function previewFromDiffContentBlocks(
  value: Record<string, unknown> | undefined,
  fallbackPath: string | undefined
): AgentToolEditPreview | undefined {
  if (!value) {
    return undefined;
  }
  const blocks =
    Array.isArray(value.content) ? value.content :
    Array.isArray(value.contents) ? value.contents :
    Array.isArray(value.items) ? value.items :
    undefined;
  if (!blocks) {
    return undefined;
  }
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    if (record.type !== "diff") {
      continue;
    }
    const path = pathFromRecords(record, value) ?? fallbackPath;
    const patchText = firstString(record, ["patch", "diffString"]);
    if (patchText?.trim()) {
      return previewFromPatch(patchText, path);
    }
    const oldText =
      typeof record.oldText === "string"
        ? record.oldText
        : record.oldText === null
          ? ""
          : undefined;
    const newText =
      typeof record.newText === "string"
        ? record.newText
        : record.newText === null
          ? ""
          : undefined;
    if (oldText != null || newText != null) {
      return previewFromBeforeAfter(oldText ?? "", newText ?? "", path, "before_after");
    }
  }
  return undefined;
}

function previewFromNestedEditContainer(
  value: Record<string, unknown> | undefined,
  fallbackPath: string | undefined,
  depth = 0
): AgentToolEditPreview | undefined {
  if (!value || depth > 3) {
    return undefined;
  }
  for (const key of ["update", "payload", "data", "result", "output"] as const) {
    const nested = asRecord(value[key]);
    const preview = extractToolEditPreview(nested, nested, fallbackPath);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

export function extractToolEditPreview(
  input: unknown,
  result: unknown,
  fallbackPath?: string
): AgentToolEditPreview | undefined {
  const inputRecord = asRecord(input);
  const resultRecord = unwrapEditPayload(result);
  const path = pathFromRecords(resultRecord, inputRecord) ?? fallbackPath;

  const patchText =
    firstString(resultRecord, ["diffString", "patch"]) ??
    firstString(inputRecord, ["diffString", "patch"]);
  if (patchText?.trim()) {
    return previewFromPatch(patchText, path);
  }

  const blockPreview =
    previewFromDiffContentBlocks(resultRecord, path) ??
    previewFromDiffContentBlocks(inputRecord, path);
  if (blockPreview) {
    return blockPreview;
  }

  const nestedPreview =
    previewFromNestedEditContainer(resultRecord, path) ??
    previewFromNestedEditContainer(inputRecord, path);
  if (nestedPreview) {
    return nestedPreview;
  }

  const beforeFull =
    firstStringIncludingEmpty(resultRecord, ["beforeFullFileContent"]) ??
    firstStringIncludingEmpty(inputRecord, ["beforeFullFileContent"]);
  const afterFull =
    firstStringIncludingEmpty(resultRecord, ["afterFullFileContent", "contents"]) ??
    firstStringIncludingEmpty(inputRecord, ["afterFullFileContent", "contents"]);
  if (beforeFull != null && afterFull != null) {
    return previewFromBeforeAfter(beforeFull, afterFull, path, "before_after");
  }

  const beforeSnippet =
    firstStringIncludingEmpty(resultRecord, ["old_string", "oldString", "before", "beforeText"]) ??
    firstStringIncludingEmpty(inputRecord, ["old_string", "oldString", "before", "beforeText"]);
  const afterSnippet =
    firstStringIncludingEmpty(resultRecord, ["new_string", "newString", "replacement", "after", "afterText"]) ??
    firstStringIncludingEmpty(inputRecord, ["new_string", "newString", "replacement", "after", "afterText"]);
  if (beforeSnippet != null && afterSnippet != null) {
    return previewFromBeforeAfter(beforeSnippet, afterSnippet, path, "replace");
  }

  const editPreview =
    previewFromEdits(resultRecord?.edits ?? resultRecord?.replacements, path) ??
    previewFromEdits(inputRecord?.edits ?? inputRecord?.replacements, path);
  if (editPreview) {
    return editPreview;
  }

  const linesAdded = firstNumber(resultRecord, ["linesAdded"]);
  const linesRemoved = firstNumber(resultRecord, ["linesRemoved"]);
  if ((linesAdded ?? 0) > 0 || (linesRemoved ?? 0) > 0) {
    return {
      path,
      source: "replace",
      addedLines: linesAdded ?? 0,
      removedLines: linesRemoved ?? 0,
      truncated: true,
      lines: [],
    };
  }

  return undefined;
}
