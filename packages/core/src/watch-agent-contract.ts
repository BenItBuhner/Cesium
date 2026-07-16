import {
  getMobileNotificationChip,
  isMobileAgentRunActive,
  type MobileAgentProjection,
  type MobilePendingIntervention,
} from "./mobile-agent-projection";

export const WATCH_SCHEMA_VERSION = 2 as const;
export const WATCH_AGENT_ACTIONS = [
  "open",
  "open_on_phone",
  "cancel",
  "pause",
  "resume",
  "answer_question",
  "answer_permission",
  "prompt",
] as const;
export const WATCH_DATA_PATHS = {
  currentProjection: "/cesium/projection/current",
  currentConfig: "/cesium/config/current",
  actionPrefix: "/cesium/action",
  phoneRelayCapability: "cesium_phone_relay",
  watchClientCapability: "cesium_watch_client",
} as const;

export type WatchConnectionSource = "direct_server" | "phone_companion" | "cache";
export type WatchAgentAction = (typeof WATCH_AGENT_ACTIONS)[number];

export type WatchAgentProjection = {
  schemaVersion: typeof WATCH_SCHEMA_VERSION;
  workspaceId: string;
  conversationId: string;
  title: string;
  status: MobileAgentProjection["status"];
  chip: string;
  currentActivity: string;
  currentTodo: string | null;
  pendingIntervention: MobilePendingIntervention;
  elapsedMs: number;
  lastEventSeq: number;
  lastError: string | null;
  progressKind?: "todo" | "burn" | null;
  progress?: number | null;
  progressMax?: number | null;
  progressLabel?: string | null;
  estimatedCompletionAt?: number | null;
  source: WatchConnectionSource;
  staleAt: number;
  availableActions: WatchAgentAction[];
};

export type WatchAgentUsageSnapshot = {
  usedTokens?: number;
  maxTokens?: number;
  percent?: number;
  label?: string;
};

export type WatchAgentSyncEnvelope = {
  schemaVersion: typeof WATCH_SCHEMA_VERSION;
  server?: {
    id?: string;
    label?: string;
    baseUrl?: string;
  };
  focused?: {
    workspaceId: string | null;
    conversationId: string | null;
    lastEventSeq?: number;
  };
  projection: WatchAgentProjection | null;
  usage?: WatchAgentUsageSnapshot | null;
  source: WatchConnectionSource;
  updatedAt: number;
};

export type WatchAgentActionRequest =
  | {
      schemaVersion: typeof WATCH_SCHEMA_VERSION;
      action: "open" | "open_on_phone" | "cancel" | "pause" | "resume";
      workspaceId?: string | null;
      conversationId: string;
    }
  | {
      schemaVersion: typeof WATCH_SCHEMA_VERSION;
      action: "answer_question";
      conversationId: string;
      questionId: string;
      answer: string;
    }
  | {
      schemaVersion: typeof WATCH_SCHEMA_VERSION;
      action: "answer_permission";
      conversationId: string;
      requestId: string;
      optionId?: string;
      cancelled?: boolean;
    }
  | {
      schemaVersion: typeof WATCH_SCHEMA_VERSION;
      action: "prompt";
      conversationId: string;
      text: string;
      delivery?: "normal" | "steer";
    };

export function toWatchAgentProjection(
  projection: MobileAgentProjection,
  options: {
    source: WatchConnectionSource;
    now?: number;
    includePromptAction?: boolean;
  }
): WatchAgentProjection {
  const now = options.now ?? Date.now();
  const progress = projection.burnProgress
    ? {
        progressKind: "burn" as const,
        progress: projection.burnProgress.percent,
        progressMax: 100,
        progressLabel: `${projection.burnProgress.percent}%`,
        estimatedCompletionAt: projection.burnProgress.estimatedCompletionAt,
      }
    : projection.todoProgress
      ? {
          progressKind: "todo" as const,
          progress: projection.todoProgress.completed,
          progressMax: projection.todoProgress.total,
          progressLabel: `${projection.todoProgress.completed}/${projection.todoProgress.total}`,
          estimatedCompletionAt: projection.todoProgress.estimatedCompletionAt,
        }
      : {
          progressKind: null,
          progress: null,
          progressMax: null,
          progressLabel: null,
          estimatedCompletionAt: null,
        };
  return {
    schemaVersion: WATCH_SCHEMA_VERSION,
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    title: projection.title,
    status: projection.status,
    chip: getMobileNotificationChip(projection.status),
    currentActivity: projection.currentActivity,
    currentTodo: projection.currentTodo,
    pendingIntervention: projection.pendingIntervention,
    elapsedMs: projection.elapsedMs,
    lastEventSeq: projection.lastEventSeq,
    lastError: projection.lastError,
    ...progress,
    source: options.source,
    staleAt: now + staleWindowForProjection(projection),
    availableActions: availableWatchActions(projection, options.includePromptAction === true),
  };
}

export function toWatchSyncEnvelope(input: {
  projection: WatchAgentProjection | null;
  source: WatchConnectionSource;
  updatedAt?: number;
  server?: WatchAgentSyncEnvelope["server"];
  focused?: WatchAgentSyncEnvelope["focused"];
  usage?: WatchAgentUsageSnapshot | null;
}): WatchAgentSyncEnvelope {
  return {
    schemaVersion: WATCH_SCHEMA_VERSION,
    server: input.server,
    focused: input.focused,
    projection: input.projection,
    usage: input.usage ?? null,
    source: input.source,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function availableWatchActions(
  projection: Pick<MobileAgentProjection, "pendingIntervention" | "status">,
  includePromptAction = false
): WatchAgentAction[] {
  const actions: WatchAgentAction[] = ["open"];
  if (projection.pendingIntervention === "question") {
    actions.push("answer_question");
  }
  if (projection.pendingIntervention === "permission") {
    actions.push("answer_permission");
  }
  if (isMobileAgentRunActive(projection.status)) {
    actions.push("pause", "cancel");
  } else if (projection.status === "paused") {
    actions.push("resume", "cancel");
  }
  actions.push("open_on_phone");
  if (includePromptAction) {
    actions.push("prompt");
  }
  return actions;
}

function staleWindowForProjection(projection: MobileAgentProjection) {
  return isMobileAgentRunActive(projection.status) ? 45_000 : 5 * 60_000;
}
