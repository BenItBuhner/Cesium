import { asString } from "./cesium-coerce.js";

export type CesiumWriteFileArgs = {
  path: string;
  content: string;
};

export type CesiumEditFileArgs = {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
};

export type CesiumFileEditOutcome = {
  /** Full file content after the operation. */
  after: string;
  /** True when the operation created a file that did not exist before. */
  created: boolean;
  /** Number of occurrences replaced (0 for pure creates). */
  replacements: number;
  /** Tool result text returned to the model. */
  resultMessage: string;
};

export function parseCesiumWriteFileArgs(args: Record<string, unknown>): CesiumWriteFileArgs {
  const path = asString(args.path);
  if (!path) {
    throw new Error("write_file.path is required.");
  }
  const content = typeof args.content === "string" ? args.content : undefined;
  if (content == null) {
    throw new Error(
      "write_file.content is required. Pass an empty string to create an empty file."
    );
  }
  return { path, content };
}

export function parseCesiumEditFileArgs(args: Record<string, unknown>): CesiumEditFileArgs {
  const path = asString(args.path);
  if (!path) {
    throw new Error("edit_file.path is required.");
  }
  return {
    path,
    oldString: typeof args.oldString === "string" ? args.oldString : "",
    newString: typeof args.newString === "string" ? args.newString : "",
    replaceAll: args.replaceAll === true,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** True when the needle appears once whitespace runs are normalized — a common near-miss. */
function hasWhitespaceInsensitiveMatch(haystack: string, needle: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) {
    return false;
  }
  return normalize(haystack).includes(normalizedNeedle);
}

function lineCountLabel(content: string): string {
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

export function describeWriteFileOutcome(input: {
  path: string;
  before: string | null;
  content: string;
}): { created: boolean; resultMessage: string } {
  const created = input.before == null;
  return {
    created,
    resultMessage: created
      ? `Created ${input.path} (${lineCountLabel(input.content)}).`
      : `Overwrote ${input.path} (${lineCountLabel(input.content)}).`,
  };
}

/**
 * Pure edit_file semantics against an in-memory snapshot (`before === null` means the
 * file does not exist yet). Throws actionable errors that tell the model exactly how
 * to recover — missing files point at write_file, ambiguous matches report the count
 * and suggest replaceAll, and near-miss matches call out whitespace drift.
 */
export function applyCesiumFileEdit(input: {
  path: string;
  before: string | null;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): CesiumFileEditOutcome {
  const { path, before, oldString, newString } = input;
  const replaceAll = input.replaceAll === true;

  if (before == null) {
    if (oldString) {
      throw new Error(
        `edit_file: ${path} does not exist. To create a new file, use write_file (or call edit_file with an empty oldString and the full content as newString). If the file should exist, verify the path with read_file or grep.`
      );
    }
    return {
      after: newString,
      created: true,
      replacements: 0,
      resultMessage: `Created ${path} (${lineCountLabel(newString)}).`,
    };
  }

  if (!oldString) {
    if (before.trim() === "") {
      return {
        after: newString,
        created: false,
        replacements: 0,
        resultMessage: `Wrote ${path} (${lineCountLabel(newString)}; file was empty).`,
      };
    }
    throw new Error(
      `edit_file.oldString is required when editing an existing, non-empty file (${path}). Include the exact text to replace, or use write_file to overwrite the whole file.`
    );
  }

  const occurrences = countOccurrences(before, oldString);
  if (occurrences === 0) {
    const whitespaceHint = hasWhitespaceInsensitiveMatch(before, oldString)
      ? " A close match exists with different whitespace/indentation — re-read the file and copy the exact text, including tabs, spaces, and line breaks."
      : " Re-read the file to copy the exact current text; it may have changed since it was last read.";
    throw new Error(`edit_file: oldString was not found in ${path}.${whitespaceHint}`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `edit_file: oldString matches ${occurrences} times in ${path}. Include more surrounding context to make it unique, or set replaceAll: true to replace every occurrence.`
    );
  }

  const first = before.indexOf(oldString);
  const after = replaceAll
    ? before.split(oldString).join(newString)
    : `${before.slice(0, first)}${newString}${before.slice(first + oldString.length)}`;
  const replacements = replaceAll ? occurrences : 1;
  return {
    after,
    created: false,
    replacements,
    resultMessage:
      replacements > 1
        ? `Edited ${path} (${replacements} replacements).`
        : `Edited ${path}.`,
  };
}
