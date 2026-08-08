import os from "node:os";
import path from "node:path";
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
  fileTouchedSince,
  unavailableReport,
} from "./helpers.js";
import type { ProviderUsageReport, UsageLimitWindow } from "./types.js";

/**
 * Claude Code usage: every assistant entry in ~/.claude/projects/**\/*.jsonl
 * carries the provider-reported `message.usage` block (input / output /
 * cache_creation / cache_read tokens) plus the model id. Anthropic does not
 * expose subscription limits locally, so alongside raw analytics we derive the
 * current rolling 5-hour session block (the unit Anthropic rate-limits on).
 */

const BASE = { id: "claude-code", label: "Claude Code", vendor: "Anthropic" } as const;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function floorToHour(epochMs: number): number {
  return Math.floor(epochMs / 3_600_000) * 3_600_000;
}

type ClaudeSample = {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

export async function collectClaudeCodeUsage(
  sinceMs: number,
  nowMs: number = Date.now()
): Promise<ProviderUsageReport> {
  const projectsRoot = path.join(claudeRoot(), "projects");
  if (!(await pathExists(projectsRoot))) {
    return unavailableReport(
      BASE,
      "No Claude Code history found (~/.claude/projects does not exist).",
      projectsRoot
    );
  }

  const files = (await listFilesRecursive(projectsRoot)).filter((file) =>
    file.endsWith(".jsonl")
  );
  const aggregator = new UsageAggregator();
  const seen = new Set<string>();
  const samples: ClaudeSample[] = [];

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
    for (const entry of entries) {
      if (asString(entry.type) !== "assistant") {
        continue;
      }
      const message = asRecord(entry.message);
      const usage = asRecord(message?.usage);
      if (!usage) {
        continue;
      }
      const model = asString(message?.model) ?? "unknown";
      // Synthetic entries are local stand-ins (errors etc.), never billed.
      if (model === "<synthetic>") {
        continue;
      }
      const ts = toEpochMs(entry.timestamp);
      if (ts === null || ts < sinceMs) {
        continue;
      }
      // The same request can be re-written across re-homed project dirs;
      // message id + requestId uniquely identify one billed API call.
      const messageId = asString(message?.id);
      const requestId = asString(entry.requestId);
      if (messageId && requestId) {
        const key = `${messageId}:${requestId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      const sample: ClaudeSample = {
        ts,
        model,
        input: asNumber(usage.input_tokens) ?? 0,
        output: asNumber(usage.output_tokens) ?? 0,
        cacheWrite: asNumber(usage.cache_creation_input_tokens) ?? 0,
        cacheRead: asNumber(usage.cache_read_input_tokens) ?? 0,
      };
      samples.push(sample);
      aggregator.add(ts, model, {
        inputTokens: sample.input,
        outputTokens: sample.output,
        cacheWriteTokens: sample.cacheWrite,
        cacheReadTokens: sample.cacheRead,
      });
      const sessionId = asString(entry.sessionId) ?? file;
      aggregator.addSession(sessionId);
    }
  }

  // Rolling 5h block: a block opens at the floor-to-hour of the first message
  // after the previous block expired (Anthropic session-block semantics).
  samples.sort((a, b) => a.ts - b.ts);
  let blockStart: number | null = null;
  let blockTokens = 0;
  let blockRequests = 0;
  for (const sample of samples) {
    if (blockStart === null || sample.ts >= blockStart + FIVE_HOURS_MS) {
      blockStart = floorToHour(sample.ts);
      blockTokens = 0;
      blockRequests = 0;
    }
    blockTokens +=
      sample.input + sample.output + sample.cacheWrite + sample.cacheRead;
    blockRequests += 1;
  }

  const limitWindows: UsageLimitWindow[] = [];
  if (blockStart !== null && nowMs < blockStart + FIVE_HOURS_MS) {
    limitWindows.push({
      id: "session-block",
      label: "Current 5h session block",
      usedPercent: null,
      windowMinutes: 300,
      resetsAt: new Date(blockStart + FIVE_HOURS_MS).toISOString(),
      capturedAt: new Date(nowMs).toISOString(),
      detail: `${blockRequests} requests · ${blockTokens.toLocaleString("en-US")} tokens this block`,
    });
  }

  const { totals, days, models, lastActivityAt } = aggregator.finish();
  return {
    ...BASE,
    available: true,
    reason: null,
    storageRoot: projectsRoot,
    plan: null,
    limitWindows,
    totals,
    days,
    models,
    estimated: false,
    lastActivityAt,
  };
}
