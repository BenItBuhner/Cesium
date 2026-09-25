import type {
  ProjectRepoBinding,
  ProjectSettings,
} from "@cesium/core/projects";
import type { AgentConversationStatus } from "../agents/types.js";

export type {
  ProjectAgentDelivery,
  ProjectChildAttention,
  ProjectChildBucket,
  ProjectChildSummary,
  ProjectContextFile,
  ProjectEngineSummary,
  ProjectOrchestratorSummary,
  ProjectRepoBinding,
  ProjectSettings,
  ProjectSnapshot,
  ProjectSummary,
} from "@cesium/core/projects";

export type ProjectChildRecord = {
  id: string;
  name: string;
  engineId: string;
  repoId: string | null;
  workspaceId: string;
  conversationId: string;
  backendId: string;
  modelId: string | null;
  mode: string;
  createdBy: "orchestrator" | "user";
  createdAt: number;
  deletedAt: number | null;
  /** Last status the watcher observed. */
  lastStatus: AgentConversationStatus | "unknown";
  turnsCompleted: number;
  /** Child `lastEventSeq` covered by the last report (or swallowed update). */
  lastReportedSeq: number;
  /**
   * Set when the orchestrator stops the child so the resulting cancellation is
   * not reported back to it. Cleared when the child is messaged through the
   * Project, or starts a new turn past `suppressedThroughSeq`.
   */
  suppressReports: boolean;
  /** Child `lastEventSeq` once the stop settled; null while it is in flight. */
  suppressedThroughSeq: number | null;
  /** Pending permission/question id last reported as needing attention. */
  lastAttentionId: string | null;
  lastReplyPreview: string | null;
  lastSeenAt: number | null;
  lastError: string | null;
};

export type ProjectRecord = {
  schemaVersion: 1;
  id: string;
  name: string;
  icon: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  orchestrator: {
    conversationId: string;
    workspaceId: string;
    backendId: "cesium-agent";
    modelId: string | null;
  };
  repos: ProjectRepoBinding[];
  children: ProjectChildRecord[];
  settings: ProjectSettings;
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  defaultChildBackendId: null,
  defaultChildModelId: null,
  maxActiveChildren: 8,
};
