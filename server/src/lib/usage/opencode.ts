import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asNumber,
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  toEpochMs,
} from "../agents/import/reader-utils.js";
import { UsageAggregator, unavailableReport } from "./helpers.js";
import type { ProviderUsageReport } from "./types.js";

/**
 * OpenCode usage: assistant message records persist provider-reported
 * `tokens` ({ input, output, reasoning, cache: { read, write } }) and real
 * `cost` in USD, plus providerID/modelID — the richest local usage data of
 * any harness. Read from opencode.db (v1) or the legacy storage tree (0.x).
 */

const BASE = { id: "opencode", label: "OpenCode", vendor: "OpenCode" } as const;

function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "opencode");
}

type SqliteRow = Record<string, unknown>;

async function openReadonlyDb(dbPath: string): Promise<{
  query: (sql: string) => SqliteRow[];
  close: () => void;
} | null> {
  try {
    const bunSqliteSpecifier = "bun:sqlite";
    const { Database } = (await import(bunSqliteSpecifier)) as {
      Database: new (
        p: string,
        opts: { readonly: boolean }
      ) => {
        query: (sql: string) => { all: () => SqliteRow[] };
        close: () => void;
      };
    };
    const db = new Database(dbPath, { readonly: true });
    return { query: (sql) => db.query(sql).all(), close: () => db.close() };
  } catch {
    // Not running under Bun — fall through to node:sqlite.
  }
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (
        p: string,
        opts: { readOnly: boolean }
      ) => {
        prepare: (sql: string) => { all: () => SqliteRow[] };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return { query: (sql) => db.prepare(sql).all(), close: () => db.close() };
  } catch {
    return null;
  }
}

function ingestMessage(
  aggregator: UsageAggregator,
  info: Record<string, unknown>,
  sessionId: string,
  fallbackTs: number | null,
  sinceMs: number
): void {
  if (asString(info.role) !== "assistant") {
    return;
  }
  const tokens = asRecord(info.tokens);
  if (!tokens) {
    return;
  }
  const time = asRecord(info.time);
  const ts = toEpochMs(time?.completed) ?? toEpochMs(time?.created) ?? fallbackTs;
  if (ts === null || ts < sinceMs) {
    return;
  }
  const cache = asRecord(tokens.cache);
  const input = asNumber(tokens.input) ?? 0;
  const output = asNumber(tokens.output) ?? 0;
  const reasoning = asNumber(tokens.reasoning) ?? 0;
  const cacheRead = asNumber(cache?.read) ?? 0;
  const cacheWrite = asNumber(cache?.write) ?? 0;
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) {
    return;
  }
  const model = asRecord(info.model)
    ? [asString(asRecord(info.model)?.providerID), asString(asRecord(info.model)?.modelID)]
        .filter(Boolean)
        .join("/") || "unknown"
    : [asString(info.providerID), asString(info.modelID)].filter(Boolean).join("/") ||
      "unknown";
  const cost = asNumber(info.cost);
  aggregator.add(ts, model, {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens:
      asNumber(tokens.total) ?? input + output + reasoning + cacheRead + cacheWrite,
    ...(cost !== undefined ? { costUsd: cost } : {}),
  });
  aggregator.addSession(sessionId);
}

export async function collectOpenCodeUsage(sinceMs: number): Promise<ProviderUsageReport> {
  const dataDir = opencodeDataDir();
  const dbPath = path.join(dataDir, "opencode.db");
  const legacyRoot = path.join(dataDir, "storage");
  const aggregator = new UsageAggregator();
  let storageRoot: string;

  if (await pathExists(dbPath)) {
    storageRoot = dbPath;
    const db = await openReadonlyDb(dbPath);
    if (!db) {
      return unavailableReport(
        BASE,
        "OpenCode database found but no SQLite driver is available in this runtime.",
        dbPath
      );
    }
    try {
      for (const row of db.query("SELECT session_id, data, time_created FROM message")) {
        const info =
          typeof row.data === "string"
            ? (() => {
                try {
                  return asRecord(JSON.parse(row.data as string));
                } catch {
                  return null;
                }
              })()
            : asRecord(row.data);
        if (!info) {
          continue;
        }
        ingestMessage(
          aggregator,
          info,
          asString(row.session_id) ?? "unknown",
          toEpochMs(row.time_created),
          sinceMs
        );
      }
    } finally {
      db.close();
    }
  } else if (await pathExists(path.join(legacyRoot, "message"))) {
    storageRoot = legacyRoot;
    const files = (await listFilesRecursive(path.join(legacyRoot, "message"))).filter(
      (file) => file.endsWith(".json")
    );
    for (const file of files) {
      try {
        const info = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
        if (!info) {
          continue;
        }
        const sessionId =
          asString(info.sessionID) ?? path.basename(path.dirname(file));
        ingestMessage(aggregator, info, sessionId, null, sinceMs);
      } catch {
        // skip unreadable message files
      }
    }
  } else {
    return unavailableReport(
      BASE,
      "No OpenCode storage found (~/.local/share/opencode).",
      dbPath
    );
  }

  const { totals, days, series, models, lastActivityAt } = aggregator.finish();
  return {
    ...BASE,
    available: true,
    reason: null,
    storageRoot,
    plan: null,
    limitWindows: [],
    limitSnapshots: [],
    totals,
    days,
    series,
    models,
    estimated: false,
    lastActivityAt,
  };
}
