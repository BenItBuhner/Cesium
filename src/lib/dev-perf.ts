export function devPerfEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const urlEnabled = new URL(window.location.href).searchParams.get("opencursorPerf") === "1";
  return urlEnabled || window.localStorage.getItem("opencursor:perf") === "1";
}

type ConversationSwitchSample = {
  conversationId: string;
  source: string;
  startedAt: number;
};

declare global {
  interface Window {
    __opencursorConversationSwitchPerf?: Map<string, ConversationSwitchSample>;
    __opencursorPerfSamples?: PerfSample[];
  }
}

export type PerfSample = {
  label: string;
  ms: number;
  at: number;
  fields?: Record<string, string | number | boolean | null | undefined>;
};

function durationMs(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

export function measureDev<T>(label: string, fn: () => T): T {
  if (!devPerfEnabled()) {
    return fn();
  }
  const start = performance.now();
  try {
    return fn();
  } finally {
    console.debug(`[perf] ${label}: ${durationMs(start)}`);
  }
}

export function recordPerfSample(
  label: string,
  startedAt: number,
  fields?: PerfSample["fields"]
): number {
  const ms = performance.now() - startedAt;
  if (!devPerfEnabled()) {
    return ms;
  }
  const sample: PerfSample = {
    label,
    ms,
    at: Date.now(),
    ...(fields ? { fields } : {}),
  };
  const samples = window.__opencursorPerfSamples ?? [];
  samples.push(sample);
  if (samples.length > 10_000) {
    samples.splice(0, samples.length - 10_000);
  }
  window.__opencursorPerfSamples = samples;
  console.debug(`[perf] ${label}: ${ms.toFixed(1)}ms`, fields ?? "");
  return ms;
}

export async function measureDevAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!devPerfEnabled()) {
    return fn();
  }
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordPerfSample(label, start);
  }
}

export function markConversationSwitchStart(
  conversationId: string | null | undefined,
  source: string
): void {
  if (!conversationId || !devPerfEnabled()) {
    return;
  }
  const samples =
    window.__opencursorConversationSwitchPerf ??
    new Map<string, ConversationSwitchSample>();
  samples.set(conversationId, {
    conversationId,
    source,
    startedAt: performance.now(),
  });
  window.__opencursorConversationSwitchPerf = samples;
}

export function markConversationSwitchVisible(
  conversationId: string | null | undefined,
  outcome: string
): void {
  if (!conversationId || !devPerfEnabled()) {
    return;
  }
  const samples = window.__opencursorConversationSwitchPerf;
  const sample = samples?.get(conversationId);
  if (!sample) {
    return;
  }
  samples?.delete(conversationId);
  recordPerfSample("conversation.switch.visible", sample.startedAt, {
    conversationId,
    source: sample.source,
    outcome,
  });
}
