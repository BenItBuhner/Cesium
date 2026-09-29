import {
  DEFAULT_PROJECT_SETTINGS_VALUES,
  type ProjectAgentKind,
  type ProjectChildEvidence,
  type ProjectHelperKind,
  type ProjectAgentIsolation,
  type ProjectPullRequest,
  type ProjectRepoBinding,
  type ProjectSettings,
} from "@cesium/core/projects";
import type { AgentConversationStatus } from "../agents/types.js";

export type {
  ProjectAgentDelivery,
  ProjectAgentIsolation,
  ProjectChildAttention,
  ProjectChildBucket,
  ProjectChildSummary,
  ProjectContextFile,
  ProjectEngineSummary,
  ProjectOrchestratorSummary,
  ProjectPullRequest,
  ProjectRepoBinding,
  ProjectSettings,
  ProjectSnapshot,
  ProjectSubscriptionSummary,
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
  /** Hidden from the Project's lists; stopped when archived, and restorable. */
  archivedAt: number | null;
  isolation: ProjectAgentIsolation;
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  /** `owner/repo` the worker's branch goes to on GitHub, if known. */
  githubRepo: string | null;
  pr: ProjectPullRequest | null;
  /** The worker's first task (clipped), for PR titles and summaries. */
  task: string | null;
  kind: ProjectAgentKind;
  helperKind: ProjectHelperKind | null;
  /** Evidence for a change to what users see, from the check after its last finished turn. */
  evidence: ProjectChildEvidence | null;
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
  schemaVersion: 2;
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
  /**
   * Pull requests no agent of the Project opened that it closed (a teammate's,
   * on the user's word), newest first, so its PR list still shows them.
   */
  closedPrs: ProjectPullRequest[];
  settings: ProjectSettings;
};

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { ...DEFAULT_PROJECT_SETTINGS_VALUES };
