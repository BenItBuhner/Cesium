import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asNumber,
  asRecord,
  asString,
  pathExists,
  readJsonLines,
  toEpochMs,
} from "../agents/import/reader-utils.js";
import {
  UsageAggregator,
  estimateTokensFromText,
  fileTouchedSince,
  unavailableReport,
} from "./helpers.js";
import type { ProviderUsageReport } from "./types.js";

/**
 * Gemini CLI / Google Antigravity usage: chat checkpoints live under
 * ~/.gemini/tmp/<projectHash>/chats/session-*.json(l). Newer builds record a
 * per-message `tokens` block ({ input, output, cached, thoughts, tool,
 * total }); when absent we fall back to a chars/4 estimate and flag the
 * report as estimated. Google does not expose plan limits locally.
 */

const BASE = {
  id: "gemini",
  label: "Gemini CLI / Antigravity",
  vendor: "Google",
} as const;

function geminiTmpRoot(): string {
  const home = process.env.GEMINI_CLI_HOME?.trim() || path.join(os.homedir(), ".gemini");
  return path.join(home, "tmp");
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === "string" ? item : (asString(asRecord(item)?.text) ?? "")
      )
      .join("");
  }
  return asString(asRecord(content)?.text) ?? "";
}

async function listChatFiles(): Promise<string[]> {
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

async function readMessages(file: string): Promise<Record<string, unknown>[]> {
  if (file.endsWith(".jsonl")) {
    const records = (await readJsonLines(file)) as Record<string, unknown>[];
    return records.filter((record) => typeof record.type === "string");
  }
  try {
    const parsed = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
    return Array.isArray(parsed?.messages)
      ? (parsed.messages as Record<string, unknown>[])
      : [];
  } catch {
    return [];
  }
}

export async function collectGeminiUsage(sinceMs: number): Promise<ProviderUsageReport> {
  const tmpRoot = geminiTmpRoot();
  if (!(await pathExists(tmpRoot))) {
    return unavailableReport(
      BASE,
      "No Gemini CLI / Antigravity chats found (~/.gemini/tmp does not exist).",
      tmpRoot
    );
  }

  const aggregator = new UsageAggregator();
  let anyEstimated = false;

  for (const file of await listChatFiles()) {
    if (!(await fileTouchedSince(file, sinceMs))) {
      continue;
    }
    const messages = await readMessages(file);
    let counted = false;
    for (const message of messages) {
      if (asString(message.type) !== "gemini") {
        continue;
      }
      const ts = toEpochMs(message.timestamp);
      if (ts === null || ts < sinceMs) {
        continue;
      }
      const model = asString(message.model) ?? "unknown";
      const tokens = asRecord(message.tokens);
      if (tokens) {
        const input = asNumber(tokens.input) ?? 0;
        const output = asNumber(tokens.output) ?? 0;
        const cached = asNumber(tokens.cached) ?? 0;
        const thoughts = asNumber(tokens.thoughts) ?? 0;
        const tool = asNumber(tokens.tool) ?? 0;
        aggregator.add(ts, model, {
          inputTokens: input,
          outputTokens: output + tool,
          cacheReadTokens: cached,
          reasoningTokens: thoughts,
          totalTokens: asNumber(tokens.total) ?? input + output + cached + thoughts + tool,
        });
      } else {
        const text = contentText(message.content);
        if (!text.trim()) {
          continue;
        }
        anyEstimated = true;
        const estimate = estimateTokensFromText(text);
        aggregator.add(ts, model, {
          outputTokens: estimate,
          totalTokens: estimate,
        });
      }
      counted = true;
    }
    if (counted) {
      aggregator.addSession(file);
    }
  }

  const { totals, days, series, models, lastActivityAt } = aggregator.finish();
  return {
    ...BASE,
    available: true,
    reason: null,
    storageRoot: tmpRoot,
    plan: null,
    limitWindows: [],
    limitSnapshots: [],
    totals,
    days,
    series,
    models,
    estimated: anyEstimated,
    lastActivityAt,
  };
}
