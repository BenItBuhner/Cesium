import type { McpServerSummary } from "@cesium/core/mcp";
import { resolveModelDisplayName } from "@cesium/core/model-display-name";
import type { AgentStoredEvent } from "../types.js";
import { asRecord, asString, asNumber } from "./cesium-coerce.js";

/** Minimum elapsed time before a time-gap environment notice is emitted (infrequent on purpose). */
export const CESIUM_TIME_GAP_REMINDER_MS = 24 * 60 * 60 * 1000;

export type CesiumEnvironmentReminderSnapshot = {
  dateLabel?: string;
  dateMs?: number;
  timeZone?: string;
  modelId?: string;
  modelName?: string;
};

export function formatCesiumDateLabel(
  date: Date | number = new Date(),
  timeZone?: string | null
): string {
  const value = typeof date === "number" ? new Date(date) : date;
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "full",
    timeStyle: "short",
  };
  if (timeZone?.trim()) {
    try {
      return value.toLocaleString("en-US", { ...options, timeZone: timeZone.trim() });
    } catch {
      // Invalid IANA zone — fall through to host-local formatting.
    }
  }
  return value.toLocaleString("en-US", options);
}

export function formatCesiumTimeGapDuration(gapMs: number): string {
  const totalMinutes = Math.max(0, Math.round(gapMs / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} day${days === 1 ? "" : "s"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (parts.length === 0 || (days === 0 && minutes > 0 && hours < 12)) {
    if (minutes > 0 && days === 0) {
      parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    }
  }
  return parts.join(", ") || "a day";
}

export function cesiumEnvironmentReminderSnapshot(input: {
  dateLabel?: string | null;
  dateMs?: number | null;
  timeZone?: string | null;
  modelId?: string | null;
  modelName?: string | null;
}): CesiumEnvironmentReminderSnapshot {
  const modelId = input.modelId?.trim() || undefined;
  const modelName = modelId
    ? resolveModelDisplayName(input.modelName, modelId)
    : input.modelName?.trim() || undefined;
  return {
    dateLabel: input.dateLabel?.trim() || undefined,
    dateMs: typeof input.dateMs === "number" && Number.isFinite(input.dateMs) ? input.dateMs : undefined,
    timeZone: input.timeZone?.trim() || undefined,
    modelId,
    modelName,
  };
}

export function latestCesiumEnvironmentReminderSnapshot(
  events: AgentStoredEvent[]
): CesiumEnvironmentReminderSnapshot | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "system_reminder") {
      continue;
    }
    const raw = asRecord(event.raw);
    const snapshot = asRecord(raw?.environmentReminderSnapshot) ?? asRecord(raw?.mcpReminderSnapshot);
    const modelId = asString(raw?.modelId) ?? asString(snapshot?.modelId);
    const modelName = asString(snapshot?.modelName) ?? asString(raw?.modelName);
    const dateLabel = asString(snapshot?.dateLabel);
    const dateMs = asNumber(snapshot?.dateMs);
    const timeZone = asString(snapshot?.timeZone);
    if (!modelId && !dateLabel && dateMs == null) {
      continue;
    }
    return cesiumEnvironmentReminderSnapshot({
      dateLabel,
      dateMs,
      timeZone,
      modelId,
      modelName,
    });
  }
  return null;
}

export function previousUserMessageCreatedAt(
  events: AgentStoredEvent[],
  excludeMessageId?: string | null
): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "user_message") {
      continue;
    }
    if (excludeMessageId && event.messageId === excludeMessageId) {
      continue;
    }
    if ("hidden" in event && event.hidden) {
      continue;
    }
    if (typeof event.createdAt === "number" && Number.isFinite(event.createdAt)) {
      return event.createdAt;
    }
  }
  return null;
}

export function cesiumEnvironmentChangeNotice(input: {
  previous: CesiumEnvironmentReminderSnapshot | null;
  current: CesiumEnvironmentReminderSnapshot;
  previousUserMessageAt?: number | null;
  minTimeGapMs?: number;
}): string | null {
  const previous = input.previous;
  if (!previous) {
    return null;
  }
  const lines: string[] = [];
  const minGap = input.minTimeGapMs ?? CESIUM_TIME_GAP_REMINDER_MS;
  const previousAt = input.previousUserMessageAt ?? previous.dateMs ?? null;
  const currentAt = input.current.dateMs ?? Date.now();
  if (previousAt != null && currentAt - previousAt >= minGap) {
    const gapLabel = formatCesiumTimeGapDuration(currentAt - previousAt);
    const zone = input.current.timeZone?.trim();
    const when =
      input.current.dateLabel?.trim() ||
      formatCesiumDateLabel(currentAt, zone);
    lines.push(
      `- A full day or more has passed since the previous user message (about ${gapLabel}). It is now ${when}${
        zone ? ` (${zone})` : ""
      }.`
    );
  }

  const previousModelId = previous.modelId?.trim();
  const currentModelId = input.current.modelId?.trim();
  if (previousModelId && currentModelId && previousModelId !== currentModelId) {
    const fromName =
      previous.modelName?.trim() ||
      resolveModelDisplayName(undefined, previousModelId);
    const toName =
      input.current.modelName?.trim() ||
      resolveModelDisplayName(undefined, currentModelId);
    lines.push(
      `- The user switched the active model from ${fromName} to ${toName}. You are now ${toName}.`
    );
  }

  return lines.length ? lines.join("\n") : null;
}

export type McpReminderSnapshot = {
  revision?: number;
  dateLabel?: string;
  dateMs?: number;
  timeZone?: string;
  modelId?: string;
  modelName?: string;
  mcpServers: Array<{ id: string; label: string; summary: string }>;
};

export function mcpReminderSnapshot(input: {
  revision?: number;
  dateLabel?: string | null;
  dateMs?: number | null;
  timeZone?: string | null;
  modelId?: string | null;
  modelName?: string | null;
  summaries: McpServerSummary[];
}): McpReminderSnapshot {
  const environment = cesiumEnvironmentReminderSnapshot(input);
  return {
    revision: input.revision,
    ...environment,
    mcpServers: input.summaries.map((summary) => ({
      id: summary.id,
      label: summary.label,
      summary: summary.summary ?? "",
    })),
  };
}

export function latestMcpReminderSnapshot(events: AgentStoredEvent[]): McpReminderSnapshot | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "system_reminder") {
      continue;
    }
    const raw = asRecord(event.raw);
    const snapshot = asRecord(raw?.mcpReminderSnapshot);
    const servers = Array.isArray(snapshot?.mcpServers)
      ? snapshot.mcpServers
          .map((entry) => {
            const record = asRecord(entry);
            const id = asString(record?.id);
            const label = asString(record?.label);
            if (!id || !label) {
              return null;
            }
            return {
              id,
              label,
              summary: asString(record?.summary) ?? "",
            };
          })
          .filter((entry): entry is McpReminderSnapshot["mcpServers"][number] => Boolean(entry))
      : null;
    if (!servers) {
      continue;
    }
    const environment = cesiumEnvironmentReminderSnapshot({
      dateLabel: asString(snapshot?.dateLabel),
      dateMs: asNumber(snapshot?.dateMs),
      timeZone: asString(snapshot?.timeZone),
      modelId: asString(snapshot?.modelId) ?? asString(raw?.modelId),
      modelName: asString(snapshot?.modelName),
    });
    return {
      revision: typeof snapshot?.revision === "number" ? snapshot.revision : undefined,
      ...environment,
      mcpServers: servers,
    };
  }
  return null;
}

export function mcpReminderChangeNotice(
  previous: McpReminderSnapshot | null,
  current: McpReminderSnapshot
): string | null {
  if (!previous) {
    return null;
  }
  const lines: string[] = [];
  if (
    previous.revision != null &&
    current.revision != null &&
    previous.revision !== current.revision
  ) {
    lines.push("- MCP catalog revision changed; reread mirrored schemas before using MCP tools.");
  }
  // Date / model disparities are handled by cesiumEnvironmentChangeNotice (6h+ threshold).
  const previousServers = new Map(previous.mcpServers.map((server) => [server.id, server]));
  const currentServers = new Map(current.mcpServers.map((server) => [server.id, server]));
  for (const [id, server] of currentServers) {
    if (!previousServers.has(id)) {
      lines.push(`- MCP server enabled: ${server.label}.`);
    }
  }
  for (const [id, server] of previousServers) {
    if (!currentServers.has(id)) {
      lines.push(`- MCP server disabled or removed: ${server.label}.`);
    }
  }
  for (const [id, server] of currentServers) {
    const prior = previousServers.get(id);
    if (prior && prior.summary !== server.summary) {
      lines.push(`- MCP server refreshed: ${server.label}.`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}
