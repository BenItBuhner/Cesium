import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type PerfSpan = {
  label: string;
  ms: number;
  at: number;
  fields?: Record<string, string | number | boolean | null | undefined>;
};

const DEFAULT_MAX_BUFFERED_SPANS = 20_000;
const perfSpans: PerfSpan[] = [];

function perfFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function serverPerfEnabled(): boolean {
  return (
    perfFlagEnabled(process.env.OPENCURSOR_PERF) ||
    perfFlagEnabled(process.env.OPENCURSOR_PERF_REPORT)
  );
}

export function startServerPerfSpan(): number {
  return performance.now();
}

export function recordServerPerfSpan(
  label: string,
  startedAt: number,
  fields?: PerfSpan["fields"]
): number {
  const ms = performance.now() - startedAt;
  if (!serverPerfEnabled()) {
    return ms;
  }
  const span: PerfSpan = {
    label,
    ms,
    at: Date.now(),
    ...(fields ? { fields } : {}),
  };
  perfSpans.push(span);
  if (perfSpans.length > DEFAULT_MAX_BUFFERED_SPANS) {
    perfSpans.splice(0, perfSpans.length - DEFAULT_MAX_BUFFERED_SPANS);
  }
  console.debug(`[perf] ${label}: ${ms.toFixed(1)}ms`, fields ?? "");
  return ms;
}

export async function measureServerPerf<T>(
  label: string,
  fn: () => Promise<T>,
  fields?: PerfSpan["fields"]
): Promise<T> {
  const startedAt = startServerPerfSpan();
  try {
    return await fn();
  } finally {
    recordServerPerfSpan(label, startedAt, fields);
  }
}

export function getServerPerfSpans(): PerfSpan[] {
  return [...perfSpans];
}

export async function flushServerPerfReport(reason: string): Promise<void> {
  if (!serverPerfEnabled() || perfSpans.length === 0) {
    return;
  }
  const target =
    process.env.OPENCURSOR_PERF_REPORT?.trim() ||
    path.join(process.cwd(), "tmp", "perf-runs", "server-spans.jsonl");
  await mkdir(path.dirname(target), { recursive: true });
  const payload = {
    reason,
    pid: process.pid,
    at: Date.now(),
    spans: perfSpans.splice(0, perfSpans.length),
  };
  await appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
}
