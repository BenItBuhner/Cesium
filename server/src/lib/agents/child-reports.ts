import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../persistence.js";

/**
 * How far into each child conversation its parent has been told: a `wait`
 * result, the blocking `subagent` reply, a parent-caused stop or an update
 * turn all mark the child's lastEventSeq as reported. Persisted, so a child
 * turn is announced once even across restarts.
 */
/** Coalesce key prefix of the update turn that tells an idle parent what its children did. */
export const CHILD_UPDATE_COALESCE_PREFIX = "child-updates:";
/** Update turns in a row without the user writing, like the Goal's continuation cap. */
export const CHILD_UPDATE_WAKE_MAX = 8;

export type ChildReport = {
  reportedSeq: number;
  /** The parent stopped this child: its stop (and the stop's trailing events) is not news to the parent. */
  quiet: boolean;
};

const cache = new Map<string, ChildReport>();

function reportFile(childConversationId: string): string {
  return path.join(DATA_DIR, "child-reports", `${childConversationId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function readStored(childConversationId: string): Promise<ChildReport | null> {
  const cached = cache.get(childConversationId);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await fs.readFile(reportFile(childConversationId), "utf8")) as Partial<ChildReport>;
    if (typeof parsed.reportedSeq === "number" && Number.isFinite(parsed.reportedSeq)) {
      const report = { reportedSeq: parsed.reportedSeq, quiet: parsed.quiet === true };
      cache.set(childConversationId, report);
      return report;
    }
  } catch {
    // No report yet.
  }
  return null;
}

async function writeStored(childConversationId: string, report: ChildReport): Promise<void> {
  cache.set(childConversationId, report);
  await fs.mkdir(path.dirname(reportFile(childConversationId)), { recursive: true });
  await fs.writeFile(reportFile(childConversationId), JSON.stringify(report), "utf8");
}

/** Marks a child reported through `seq` (never backwards); `quiet` set or cleared when given. */
export async function markChildReported(
  childConversationId: string,
  seq: number,
  options?: { quiet?: boolean }
): Promise<void> {
  const current = await readStored(childConversationId);
  const reportedSeq = Math.max(current?.reportedSeq ?? seq, seq);
  const quiet = options?.quiet ?? current?.quiet ?? false;
  if (current && current.reportedSeq === reportedSeq && current.quiet === quiet) return;
  await writeStored(childConversationId, { reportedSeq, quiet });
}

/**
 * The child's report. A child seen for the first time (one spawned before
 * reports existed) starts reported through where it is now, so an upgrade
 * never announces old turns.
 */
export async function childReport(child: { id: string; lastEventSeq: number }): Promise<ChildReport> {
  const stored = await readStored(child.id);
  if (stored) return stored;
  const report = { reportedSeq: child.lastEventSeq, quiet: false };
  await writeStored(child.id, report);
  return report;
}
