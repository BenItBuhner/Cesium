import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../persistence.js";
import { ProjectError } from "./errors.js";

// Lasting user preferences, shared by every Project and every agent on this engine.

export const PREFERENCES_MAX_CHARS = 8_000;
const PREFERENCE_MAX_CHARS = 500;

let writes: Promise<unknown> = Promise.resolve();

/** Read-modify-writes of the one preferences file run one at a time. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = writes.then(task, task);
  writes = next.catch(() => undefined);
  return next;
}

const HEADER = [
  "# Preferences",
  "",
  "Lasting preferences for every Cesium Project and its agents on this engine. The",
  "coordinator adds lines when you state one; edit freely.",
  "",
];

export function getPreferencesPath(): string {
  return path.join(DATA_DIR, "profile", "preferences.md");
}

export async function readPreferences(): Promise<string> {
  return fs.readFile(getPreferencesPath(), "utf8").catch(() => "");
}

/** The `- ` lines of the preferences file. */
export function listPreferenceLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

async function writePreferences(markdown: string): Promise<void> {
  if (markdown.length > PREFERENCES_MAX_CHARS) {
    throw new ProjectError(
      `Preferences would exceed ${PREFERENCES_MAX_CHARS} characters; remove some first.`
    );
  }
  const file = getPreferencesPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, markdown, "utf8");
  await fs.rename(temp, file);
}

export function replacePreferences(markdown: string): Promise<string> {
  return serialized(async () => {
    await writePreferences(markdown);
    return markdown;
  });
}

export function addPreference(text: string): Promise<string> {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) {
    return Promise.reject(new ProjectError("A preference needs text."));
  }
  if (line.length > PREFERENCE_MAX_CHARS) {
    return Promise.reject(new ProjectError(`Keep a preference under ${PREFERENCE_MAX_CHARS} characters.`));
  }
  return serialized(async () => {
    const current = await readPreferences();
    if (listPreferenceLines(current).some((existing) => existing.toLowerCase() === line.toLowerCase())) {
      return current;
    }
    const base = current.trim() ? current.replace(/\s*$/, "\n") : `${HEADER.join("\n")}`;
    const next = `${base}- ${line}\n`;
    await writePreferences(next);
    return next;
  });
}

/** Removes every line containing `match` (case-insensitive). */
export function removePreference(match: string): Promise<{ markdown: string; removed: string[] }> {
  const needle = match.trim().toLowerCase();
  if (!needle) {
    return Promise.reject(new ProjectError("Say which preference to remove."));
  }
  return serialized(async () => {
    const current = await readPreferences();
    const removed: string[] = [];
    const kept = current.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && trimmed.toLowerCase().includes(needle)) {
        removed.push(trimmed.slice(2).trim());
        return false;
      }
      return true;
    });
    if (removed.length === 0) {
      throw new ProjectError(`No preference mentions "${match}".`, 404);
    }
    const next = kept.join("\n");
    await writePreferences(next);
    return { markdown: next, removed };
  });
}
