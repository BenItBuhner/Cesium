import path from "node:path";
import { getPiAgentDir } from "../pi-agent-settings.js";
import {
  asNumber,
  asRecord,
  asString,
  listFilesRecursive,
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
 * Pi (pi-mono coding agent) usage: assistant message entries in the session
 * JSONL trees persist a `usage` block ({ input, output, cacheRead,
 * cacheWrite, cost: { total } }) plus the model id. When a build omits usage
 * we fall back to chars/4 estimation of the assistant text.
 */

const BASE = { id: "pi", label: "Pi Agent", vendor: "Pi" } as const;

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      const rec = asRecord(block);
      if (!rec) {
        return "";
      }
      if (rec.type === "text" && typeof rec.text === "string") {
        return rec.text;
      }
      if (rec.type === "thinking" && typeof rec.thinking === "string") {
        return rec.thinking;
      }
      return "";
    })
    .join("");
}

export async function collectPiUsage(sinceMs: number): Promise<ProviderUsageReport> {
  const sessionsRoot = path.join(getPiAgentDir(), "sessions");
  if (!(await pathExists(sessionsRoot))) {
    return unavailableReport(
      BASE,
      "No Pi agent sessions found (~/.pi/agent/sessions does not exist).",
      sessionsRoot
    );
  }

  const files = (await listFilesRecursive(sessionsRoot)).filter((file) =>
    file.endsWith(".jsonl")
  );
  const aggregator = new UsageAggregator();
  let anyEstimated = false;

  for (const file of files) {
    if (!(await fileTouchedSince(file, sinceMs))) {
      continue;
    }
    let entries: Record<string, unknown>[];
    try {
      entries = (await readJsonLines(file)) as Record<string, unknown>[];
    } catch {
      continue;
    }
    let model = "unknown";
    let counted = false;
    for (const entry of entries) {
      const entryType = asString(entry.type);
      if (entryType === "model_change") {
        model =
          asString(entry.modelId) ??
          asString(entry.model) ??
          asString(asRecord(entry.model)?.id) ??
          model;
        continue;
      }
      if (entryType !== "message") {
        continue;
      }
      const message = asRecord(entry.message);
      if (asString(message?.role) !== "assistant") {
        continue;
      }
      const ts =
        toEpochMs(entry.timestamp) ?? toEpochMs(message?.timestamp);
      if (ts === null || ts < sinceMs) {
        continue;
      }
      const messageModel =
        asString(message?.model) ?? asString(message?.modelId) ?? model;
      const usage = asRecord(message?.usage);
      if (usage) {
        const cost = asRecord(usage.cost);
        aggregator.add(ts, messageModel, {
          inputTokens: asNumber(usage.input) ?? 0,
          outputTokens: asNumber(usage.output) ?? 0,
          cacheReadTokens: asNumber(usage.cacheRead) ?? 0,
          cacheWriteTokens: asNumber(usage.cacheWrite) ?? 0,
          ...(asNumber(cost?.total) !== undefined
            ? { costUsd: asNumber(cost?.total)! }
            : {}),
        });
      } else {
        const text = assistantText(message?.content);
        if (!text.trim()) {
          continue;
        }
        anyEstimated = true;
        const estimate = estimateTokensFromText(text);
        aggregator.add(ts, messageModel, {
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
    storageRoot: sessionsRoot,
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
