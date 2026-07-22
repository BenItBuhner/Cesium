import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "../../db/client.js";
import * as schema from "../../db/schema.js";
import { measureServerPerf } from "../../lib/perf.js";
import type {
  AgentBackendId,
  AgentConversationConfig,
  AgentConversationRecord,
  AgentConversationStatus,
  AgentEventInput,
  AgentPendingPermission,
  AgentProviderCapabilities,
  AgentStoredEvent,
  AgentConfigOption,
} from "../../lib/agents/types.js";
import type { GlobalSettings } from "../../lib/global-settings-store.js";
import { HOME_WORKSPACE_DISPLAY_NAME } from "../../lib/workspace-constants.js";
import type {
  WorkspaceProfileFile,
  WorkspaceRecord,
} from "../../lib/workspace-registry.js";
import type {
  PersistedWorkspaceSession,
  WorkspaceWindowRecord,
} from "../../lib/workspace-session-store.js";
import type {
  OrchestrationAssignmentRecord,
  OrchestrationBoardListResult,
  OrchestrationBoardRecord,
  OrchestrationBoardSnapshot,
  OrchestrationEventKind,
  OrchestrationEventRecord,
  OrchestrationIssuePriority,
  OrchestrationIssueRecord,
} from "../../lib/orchestration/types.js";
import type {
  BurnGoalPatch,
  BurnGoalRecord,
} from "../../lib/agents/burn-goal-types.js";
import {
  normalizeBurnGoalProgressPercent,
  normalizeBurnGoalRevision,
  normalizeBurnGoalSnapshots,
} from "../../lib/agents/burn-goal-types.js";
import type {
  ExtensionInstallRecord,
  ExtensionPermissionGrant,
} from "../../lib/extensions/types.js";
import {
  StorageConflictError,
  type AgentProviderCacheRecord,
  type AppendAgentEventsInput,
  type ListAgentConversationsInput,
  type ListAgentConversationsResult,
  type ReadAgentEventsInput,
  type StorageDriver,
} from "../driver.js";

/** Empty sentinel used for the workspace-level session (window_id column is NOT NULL). */
const WORKSPACE_SESSION_WINDOW_ID = "";

type ConversationRow = typeof schema.agentConversations.$inferSelect;
type EventRow = typeof schema.agentEvents.$inferSelect;
type OrchestrationBoardRow = typeof schema.orchestrationBoards.$inferSelect;
type OrchestrationIssueRow = typeof schema.orchestrationIssues.$inferSelect;
type OrchestrationAssignmentRow =
  typeof schema.orchestrationAssignments.$inferSelect;
type OrchestrationEventRow = typeof schema.orchestrationEvents.$inferSelect;
type BurnGoalRow = typeof schema.burnGoals.$inferSelect;
type ExtensionInstallRow = typeof schema.extensionInstalls.$inferSelect;

function rowToWorkspace(row: typeof schema.workspaces.$inferSelect): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
  };
}

function rowToWindow(
  row: typeof schema.workspaceWindows.$inferSelect
): WorkspaceWindowRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
    ...(row.lastFocusedAt !== null ? { lastFocusedAt: row.lastFocusedAt } : {}),
    ...(row.closedAt !== null ? { closedAt: row.closedAt } : {}),
  };
}

function rowToConversation(row: ConversationRow): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastEventSeq: row.lastEventSeq,
    lastReadSeq: row.lastReadSeq,
    status: row.status as AgentConversationStatus,
    config: row.config as AgentConversationConfig,
    providerSessionId: row.providerSessionId,
    configOptions: (row.configOptions ?? []) as AgentConfigOption[],
    capabilities: row.capabilities as AgentProviderCapabilities,
    pendingPermission:
      (row.pendingPermission as AgentPendingPermission | null) ?? null,
    pendingQuestion: null,
    lastError: row.lastError,
    experimental: row.experimental,
    archivedAt: row.archivedAt,
    origin:
      ((row as ConversationRow & { origin?: unknown })
        .origin as AgentConversationRecord["origin"]) ?? null,
    queuedPrompts: Array.isArray(
      (row as ConversationRow & { queuedPrompts?: unknown }).queuedPrompts
    )
      ? (row as ConversationRow & { queuedPrompts: AgentConversationRecord["queuedPrompts"] })
          .queuedPrompts
      : [],
  };
}

function rowToEvent(row: EventRow): AgentStoredEvent {
  // payload contains the kind-specific fields (user_message text, tool_call
  // title, etc). Spread it first, then pin the envelope fields so a malformed
  // row can't accidentally override them.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    ...payload,
    conversationId: row.conversationId,
    seq: row.seq,
    eventId: row.eventId,
    kind: row.kind,
    createdAt: row.createdAt,
  } as AgentStoredEvent;
}

function rowToOrchestrationBoard(
  row: OrchestrationBoardRow
): OrchestrationBoardRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    headConversationId: row.headConversationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    settings: row.settings as OrchestrationBoardRecord["settings"],
  };
}

function rowToOrchestrationIssue(
  row: OrchestrationIssueRow
): OrchestrationIssueRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    boardId: row.boardId,
    title: row.title,
    description: row.description,
    columnId: row.columnId as OrchestrationIssueRecord["columnId"],
    priority: row.priority as OrchestrationIssuePriority,
    sortOrder: row.sortOrder,
    acceptanceCriteria: Array.isArray(row.acceptanceCriteria)
      ? row.acceptanceCriteria
      : [],
    dependencyIssueIds: Array.isArray(row.dependencyIssueIds)
      ? row.dependencyIssueIds
      : [],
    blockedReason: row.blockedReason,
    verification: row.verification as OrchestrationIssueRecord["verification"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function rowToOrchestrationAssignment(
  row: OrchestrationAssignmentRow
): OrchestrationAssignmentRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    boardId: row.boardId,
    issueId: row.issueId,
    conversationId: row.conversationId,
    role: row.role,
    status: row.status as OrchestrationAssignmentRecord["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    config: row.config as OrchestrationAssignmentRecord["config"],
    lastKnownConversationStatus:
      row.lastKnownConversationStatus as OrchestrationAssignmentRecord["lastKnownConversationStatus"],
  };
}

function rowToOrchestrationEvent(
  row: OrchestrationEventRow
): OrchestrationEventRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    boardId: row.boardId,
    issueId: row.issueId,
    assignmentId: row.assignmentId,
    kind: row.kind as OrchestrationEventKind,
    actor: row.actor as OrchestrationEventRecord["actor"],
    message: row.message,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

function rowToBurnGoal(row: BurnGoalRow): BurnGoalRecord {
  const payload = row.payload as Partial<BurnGoalRecord>;
  return {
    schemaVersion: 1,
    goalId: row.goalId,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    objective: row.objective,
    status: row.status as BurnGoalRecord["status"],
    phase: row.phase as BurnGoalRecord["phase"],
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    timeUsedSeconds: row.timeUsedSeconds,
    progressPercent: normalizeBurnGoalProgressPercent(payload.progressPercent),
    headline: typeof payload.headline === "string" && payload.headline.trim()
      ? payload.headline.trim()
      : null,
    revision: normalizeBurnGoalRevision(payload.revision),
    planSummary: typeof payload.planSummary === "string" ? payload.planSummary : "",
    milestones: Array.isArray(payload.milestones) ? payload.milestones : [],
    todos: Array.isArray(payload.todos) ? payload.todos : [],
    blockerHistory: Array.isArray(payload.blockerHistory) ? payload.blockerHistory : [],
    verificationEvidence: Array.isArray(payload.verificationEvidence)
      ? payload.verificationEvidence
      : [],
    snapshots: normalizeBurnGoalSnapshots(payload.snapshots),
    compaction:
      payload.compaction && typeof payload.compaction === "object"
        ? payload.compaction as BurnGoalRecord["compaction"]
        : { generation: 0 },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function burnGoalPayload(record: BurnGoalRecord): Record<string, unknown> {
  return {
    planSummary: record.planSummary,
    progressPercent: record.progressPercent,
    headline: record.headline,
    revision: record.revision,
    milestones: record.milestones,
    todos: record.todos,
    blockerHistory: record.blockerHistory,
    verificationEvidence: record.verificationEvidence,
    snapshots: record.snapshots,
    compaction: record.compaction,
  };
}

function rowToExtensionInstall(row: ExtensionInstallRow): ExtensionInstallRecord {
  return row.payload as ExtensionInstallRecord;
}

function buildEventPayload(event: AgentEventInput): Record<string, unknown> {
  const { conversationId: _cid, eventId: _eid, kind: _kind, createdAt: _cat, ...rest } =
    event as AgentEventInput & { createdAt?: number };
  return rest;
}

type ConversationCursor = { updatedAt: number; id: string };

function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null | undefined): ConversationCursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      decoded &&
      typeof decoded === "object" &&
      typeof decoded.updatedAt === "number" &&
      typeof decoded.id === "string"
    ) {
      return { updatedAt: decoded.updatedAt, id: decoded.id };
    }
  } catch {
    // fall through
  }
  return null;
}

export class PgStorageDriver implements StorageDriver {
  readonly kind = "pg" as const;

  async init(): Promise<void> {
    if (!hasDatabaseUrl()) {
      throw new Error(
        "OPENCURSOR_STORAGE_DRIVER=pg requires DATABASE_URL. Configure it or run with legacy-json."
      );
    }
    // Open the pool AND run a lightweight probe so the first real query
    // (often from a WS handler) doesn't eat a full connect-timeout window
    // when Docker/WSL is warming up.
    const { verifyDbConnection } = await import("../../db/client.js");
    await verifyDbConnection();
  }

  async close(): Promise<void> {
    // Pool teardown is handled centrally via shutdown hooks in db/client.ts.
  }

  // ---------- workspaces ----------
  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const rows = await getDb().select().from(schema.workspaces);
    const records = rows.map(rowToWorkspace);
    // Match legacy sort: Home workspace first, then by lastOpenedAt desc,
    // then alphabetically. Stays consistent whichever driver is active.
    records.sort((a, b) => {
      const aHome = a.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
      const bHome = b.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      return b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name);
    });
    return records;
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    return row ? rowToWorkspace(row) : null;
  }

  async getWorkspaceByRoot(root: string): Promise<WorkspaceRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.root, root))
      .limit(1);
    return row ? rowToWorkspace(row) : null;
  }

  async upsertWorkspace(record: WorkspaceRecord): Promise<void> {
    await getDb()
      .insert(schema.workspaces)
      .values({
        id: record.id,
        name: record.name,
        root: record.root,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastOpenedAt: record.lastOpenedAt,
      })
      .onConflictDoUpdate({
        target: schema.workspaces.id,
        set: {
          name: record.name,
          root: record.root,
          updatedAt: record.updatedAt,
          lastOpenedAt: record.lastOpenedAt,
        },
      });
  }

  async deleteWorkspace(id: string): Promise<void> {
    await getDb()
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
  }

  async getWorkspaceProfile(): Promise<WorkspaceProfileFile> {
    const [row] = await getDb()
      .select()
      .from(schema.workspaceProfile)
      .where(eq(schema.workspaceProfile.id, 1))
      .limit(1);
    if (!row) {
      return {
        schemaVersion: 1,
        defaultWorkspaceId: null,
        lastOpenedWorkspaceId: null,
        recentWorkspaceIds: [],
      };
    }
    return {
      schemaVersion: 1,
      defaultWorkspaceId: row.defaultWorkspaceId,
      lastOpenedWorkspaceId: row.lastOpenedWorkspaceId,
      recentWorkspaceIds: Array.isArray(row.recentWorkspaceIds)
        ? row.recentWorkspaceIds
        : [],
    };
  }

  async saveWorkspaceProfile(profile: WorkspaceProfileFile): Promise<void> {
    const now = Date.now();
    await getDb()
      .insert(schema.workspaceProfile)
      .values({
        id: 1,
        defaultWorkspaceId: profile.defaultWorkspaceId,
        lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
        recentWorkspaceIds: profile.recentWorkspaceIds ?? [],
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.workspaceProfile.id,
        set: {
          defaultWorkspaceId: profile.defaultWorkspaceId,
          lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
          recentWorkspaceIds: profile.recentWorkspaceIds ?? [],
          updatedAt: now,
        },
      });
  }

  // ---------- workspace sessions + windows ----------
  async getWorkspaceSession(
    workspaceId: string
  ): Promise<PersistedWorkspaceSession | null> {
    const [row] = await getDb()
      .select()
      .from(schema.workspaceSessions)
      .where(
        and(
          eq(schema.workspaceSessions.workspaceId, workspaceId),
          eq(schema.workspaceSessions.windowId, WORKSPACE_SESSION_WINDOW_ID)
        )
      )
      .limit(1);
    if (!row) return null;
    const payload = row.payload as PersistedWorkspaceSession;
    if (!payload || payload.schemaVersion !== 1) return null;
    return payload;
  }

  async saveWorkspaceSession(
    workspaceId: string,
    session: PersistedWorkspaceSession,
    expectedRevision?: number
  ): Promise<{ revision: number }> {
    return upsertSessionWithRevision({
      workspaceId,
      windowId: WORKSPACE_SESSION_WINDOW_ID,
      payload: session,
      expectedRevision,
    });
  }

  async listWorkspaceWindows(
    workspaceId: string
  ): Promise<WorkspaceWindowRecord[]> {
    const rows = await getDb()
      .select()
      .from(schema.workspaceWindows)
      .where(eq(schema.workspaceWindows.workspaceId, workspaceId))
      .orderBy(desc(schema.workspaceWindows.lastOpenedAt));
    return rows.map(rowToWindow);
  }

  async saveWorkspaceWindows(
    workspaceId: string,
    windows: WorkspaceWindowRecord[]
  ): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.workspaceWindows)
        .where(eq(schema.workspaceWindows.workspaceId, workspaceId));
      if (windows.length === 0) return;
      await tx.insert(schema.workspaceWindows).values(
        windows.map((window) => ({
          id: window.id,
          workspaceId,
          label: window.label,
          createdAt: window.createdAt,
          updatedAt: window.updatedAt,
          lastOpenedAt: window.lastOpenedAt,
          lastFocusedAt: window.lastFocusedAt ?? null,
          closedAt: window.closedAt ?? null,
        }))
      );
    });
  }

  async getWorkspaceWindowSession(
    workspaceId: string,
    windowId: string
  ): Promise<PersistedWorkspaceSession | null> {
    if (!windowId) return null;
    const [row] = await getDb()
      .select()
      .from(schema.workspaceSessions)
      .where(
        and(
          eq(schema.workspaceSessions.workspaceId, workspaceId),
          eq(schema.workspaceSessions.windowId, windowId)
        )
      )
      .limit(1);
    if (!row) return null;
    const payload = row.payload as PersistedWorkspaceSession;
    if (!payload || payload.schemaVersion !== 1) return null;
    return payload;
  }

  async saveWorkspaceWindowSession(
    workspaceId: string,
    windowId: string,
    session: PersistedWorkspaceSession,
    expectedRevision?: number
  ): Promise<{ revision: number }> {
    if (!windowId) {
      throw new Error(
        "saveWorkspaceWindowSession requires a non-empty windowId."
      );
    }
    return upsertSessionWithRevision({
      workspaceId,
      windowId,
      payload: session,
      expectedRevision,
    });
  }

  // ---------- global settings ----------
  async getGlobalSettings(): Promise<GlobalSettings | null> {
    const [row] = await getDb()
      .select()
      .from(schema.globalSettings)
      .where(eq(schema.globalSettings.id, 1))
      .limit(1);
    if (!row) return null;
    return row.payload as GlobalSettings;
  }

  async saveGlobalSettings(
    settings: GlobalSettings,
    expectedRevision?: number
  ): Promise<{ revision: number }> {
    const db = getDb();
    const now = Date.now();
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          revision: schema.globalSettings.revision,
        })
        .from(schema.globalSettings)
        .where(eq(schema.globalSettings.id, 1))
        .for("update");

      if (!existing) {
        if (expectedRevision !== undefined && expectedRevision !== 0) {
          throw new StorageConflictError(
            "global_settings revision mismatch (row does not exist)",
            { expectedRevision, actualRevision: 0 }
          );
        }
        await tx.insert(schema.globalSettings).values({
          id: 1,
          payload: settings as unknown as Record<string, unknown>,
          revision: 1,
          updatedAt: now,
        });
        return { revision: 1 };
      }

      if (
        expectedRevision !== undefined &&
        expectedRevision !== existing.revision
      ) {
        throw new StorageConflictError(
          `global_settings revision mismatch (expected ${expectedRevision}, actual ${existing.revision})`,
          { expectedRevision, actualRevision: existing.revision }
        );
      }
      const nextRevision = existing.revision + 1;
      await tx
        .update(schema.globalSettings)
        .set({
          payload: settings as unknown as Record<string, unknown>,
          revision: nextRevision,
          updatedAt: now,
        })
        .where(eq(schema.globalSettings.id, 1));
      return { revision: nextRevision };
    });
  }

  // ---------- auth ----------
  async getAuthState(): Promise<{
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  } | null> {
    const [row] = await getDb()
      .select()
      .from(schema.authState)
      .where(eq(schema.authState.id, 1))
      .limit(1);
    if (!row) return null;
    return {
      schemaVersion: row.schemaVersion,
      secret: row.secret,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async saveAuthState(state: {
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    await getDb()
      .insert(schema.authState)
      .values({
        id: 1,
        schemaVersion: state.schemaVersion,
        secret: state.secret,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.authState.id,
        set: {
          schemaVersion: state.schemaVersion,
          secret: state.secret,
          updatedAt: state.updatedAt,
        },
      });
  }

  async listAuthSessions(): Promise<
    Array<{
      id: string;
      username: string;
      createdAt: number;
      lastSeenAt: number;
      lastRotatedAt: number;
      expiresAt: number;
      remember: boolean;
    }>
  > {
    const now = Date.now();
    const rows = await getDb()
      .select()
      .from(schema.authSessions);
    return rows
      .filter((row) => row.expiresAt > now)
      .map((row) => ({
        id: row.id,
        username: row.username,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        lastRotatedAt: row.lastRotatedAt,
        expiresAt: row.expiresAt,
        remember: row.remember,
      }));
  }

  async saveAuthSessions(
    sessions: Array<{
      id: string;
      username: string;
      createdAt: number;
      lastSeenAt: number;
      lastRotatedAt: number;
      expiresAt: number;
      remember: boolean;
    }>
  ): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      // Wholesale replace: legacy saveAuthSessions writes the entire file on
      // every change (logout, new login, rotation), so matching that semantic
      // is simplest and avoids subtle divergence across drivers.
      await tx.delete(schema.authSessions);
      if (sessions.length === 0) return;
      await tx.insert(schema.authSessions).values(sessions);
    });
  }

  // ---------- agent conversations ----------
  async listAgentConversations(
    input: ListAgentConversationsInput
  ): Promise<ListAgentConversationsResult> {
    return measureServerPerf(
      "pg.listAgentConversations",
      () => this.listAgentConversationsUnmeasured(input),
      { workspaceId: input.workspaceId ?? null, limit: input.limit ?? null }
    );
  }

  private async listAgentConversationsUnmeasured(
    input: ListAgentConversationsInput
  ): Promise<ListAgentConversationsResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const db = getDb();
    const cursor = decodeCursor(input.cursor);

    const filters = [];
    if (input.workspaceId) {
      filters.push(eq(schema.agentConversations.workspaceId, input.workspaceId));
    }
    if (!input.includeArchived) {
      filters.push(sql`${schema.agentConversations.archivedAt} IS NULL`);
    }
    if (cursor) {
      // Keyset pagination: sort order is (updatedAt DESC, id ASC).
      // Next page starts where (updated_at, id) < (cursor.updatedAt, cursor.id)
      // lexicographically under that ordering.
      filters.push(
        or(
          lt(schema.agentConversations.updatedAt, cursor.updatedAt),
          and(
            eq(schema.agentConversations.updatedAt, cursor.updatedAt),
            sql`${schema.agentConversations.id} > ${cursor.id}`
          )
        )!
      );
    }

    const rows = await db
      .select()
      .from(schema.agentConversations)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        desc(schema.agentConversations.updatedAt),
        asc(schema.agentConversations.id)
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const window = hasMore ? rows.slice(0, limit) : rows;
    const last = window[window.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
        : null;

    return { records: window.map(rowToConversation), nextCursor };
  }

  async getAgentConversation(
    id: string
  ): Promise<AgentConversationRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.agentConversations)
      .where(eq(schema.agentConversations.id, id))
      .limit(1);
    return row ? rowToConversation(row) : null;
  }

  async upsertAgentConversation(record: AgentConversationRecord): Promise<void> {
    const values = {
      id: record.id,
      workspaceId: record.workspaceId,
      schemaVersion: record.schemaVersion ?? 1,
      title: record.title,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastEventSeq: record.lastEventSeq,
      lastReadSeq: record.lastReadSeq,
      config: record.config as unknown as Record<string, unknown>,
      providerSessionId: record.providerSessionId ?? null,
      configOptions: (record.configOptions ?? []) as unknown as unknown[],
      capabilities: record.capabilities as unknown as Record<string, unknown>,
      pendingPermission:
        (record.pendingPermission ?? null) as unknown as Record<
          string,
          unknown
        > | null,
      lastError: record.lastError ?? null,
      experimental: record.experimental ?? false,
      archivedAt: record.archivedAt ?? null,
      queuedPrompts: (record.queuedPrompts ?? []) as unknown as unknown[],
      origin: (record.origin ?? null) as unknown as Record<string, unknown> | null,
    };
    await getDb()
      .insert(schema.agentConversations)
      .values(values)
      .onConflictDoUpdate({
        target: schema.agentConversations.id,
        set: {
          title: values.title,
          status: values.status,
          updatedAt: values.updatedAt,
          lastEventSeq: values.lastEventSeq,
          lastReadSeq: values.lastReadSeq,
          config: values.config,
          providerSessionId: values.providerSessionId,
          configOptions: values.configOptions,
          capabilities: values.capabilities,
          pendingPermission: values.pendingPermission,
          lastError: values.lastError,
          experimental: values.experimental,
          archivedAt: values.archivedAt,
          queuedPrompts: values.queuedPrompts,
          origin: values.origin,
        },
      });
  }

  async deleteAgentConversation(id: string): Promise<void> {
    // FK onDelete: cascade handles the agent_events rows in the same statement.
    await getDb()
      .delete(schema.agentConversations)
      .where(eq(schema.agentConversations.id, id));
  }

  async appendAgentEvents(
    input: AppendAgentEventsInput
  ): Promise<{ events: AgentStoredEvent[]; newLastSeq: number }> {
    return measureServerPerf(
      "pg.appendAgentEvents",
      () => this.appendAgentEventsUnmeasured(input),
      { conversationId: input.conversationId, events: input.events.length }
    );
  }

  private async appendAgentEventsUnmeasured(
    input: AppendAgentEventsInput
  ): Promise<{ events: AgentStoredEvent[]; newLastSeq: number }> {
    if (input.events.length === 0) {
      return { events: [], newLastSeq: 0 };
    }
    const db = getDb();
    return db.transaction(async (tx) => {
      const [meta] = await tx
        .select({
          id: schema.agentConversations.id,
          workspaceId: schema.agentConversations.workspaceId,
          lastEventSeq: schema.agentConversations.lastEventSeq,
          updatedAt: schema.agentConversations.updatedAt,
        })
        .from(schema.agentConversations)
        .where(eq(schema.agentConversations.id, input.conversationId))
        .for("update")
        .limit(1);

      if (!meta) {
        throw new Error(`Unknown conversation: ${input.conversationId}`);
      }

      const now = Date.now();
      let nextSeq = meta.lastEventSeq + 1;
      const stored: AgentStoredEvent[] = input.events.map((event) => ({
        ...event,
        seq: nextSeq++,
        createdAt: event.createdAt ?? now,
      })) as AgentStoredEvent[];

      const rows = stored.map((event) => ({
        conversationId: meta.id,
        seq: event.seq,
        eventId: event.eventId,
        kind: event.kind,
        payload: buildEventPayload(event),
        createdAt: event.createdAt,
      }));

      await tx.insert(schema.agentEvents).values(rows);

      const newLastSeq = stored[stored.length - 1]!.seq;
      const bumpListRank = stored.some((e) => e.kind === "user_message");
      await tx
        .update(schema.agentConversations)
        .set({
          lastEventSeq: newLastSeq,
          updatedAt: bumpListRank ? Math.max(meta.updatedAt + 1, now) : meta.updatedAt,
          ...(input.conversationPatch?.status !== undefined
            ? { status: input.conversationPatch.status }
            : {}),
          ...(input.conversationPatch?.pendingPermission !== undefined
            ? {
                pendingPermission: input.conversationPatch.pendingPermission as unknown as Record<
                  string,
                  unknown
                > | null,
              }
            : {}),
          ...(input.conversationPatch?.lastError !== undefined
            ? { lastError: input.conversationPatch.lastError }
            : {}),
        })
        .where(eq(schema.agentConversations.id, input.conversationId));

    return { events: stored, newLastSeq };
  });
}

async deleteAgentEvents(input: {
  conversationId: string;
  eventIds: string[];
}): Promise<number> {
  if (input.eventIds.length === 0) {
    return 0;
  }
  await getDb()
    .delete(schema.agentEvents)
    .where(
      and(
        eq(schema.agentEvents.conversationId, input.conversationId),
        inArray(schema.agentEvents.eventId, input.eventIds)
      )
    );
  return input.eventIds.length;
}

async readAgentEvents(input: ReadAgentEventsInput): Promise<AgentStoredEvent[]> {
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 10_000) : 10_000;
    const rows = await getDb()
      .select()
      .from(schema.agentEvents)
      .where(
        and(
          eq(schema.agentEvents.conversationId, input.conversationId),
          sql`${schema.agentEvents.seq} > ${input.afterSeq ?? 0}`
        )
      )
      .orderBy(asc(schema.agentEvents.seq))
      .limit(limit);
    return rows.map(rowToEvent);
  }

  async readAgentEventsOlderThan(input: {
    conversationId: string;
    beforeSeq: number;
    limit: number;
  }): Promise<AgentStoredEvent[]> {
    const cap = Math.max(1, Math.min(input.limit, 100_000));
    const rows = await getDb()
      .select()
      .from(schema.agentEvents)
      .where(
        and(
          eq(schema.agentEvents.conversationId, input.conversationId),
          lt(schema.agentEvents.seq, input.beforeSeq)
        )
      )
      .orderBy(desc(schema.agentEvents.seq))
      .limit(cap);
    return rows.reverse().map(rowToEvent);
  }

  async readRecentAgentEvents(
    conversationId: string,
    limit: number
  ): Promise<AgentStoredEvent[]> {
    const bounded = Math.max(1, Math.min(limit, 10_000));
    const rows = await getDb()
      .select()
      .from(schema.agentEvents)
      .where(eq(schema.agentEvents.conversationId, conversationId))
      .orderBy(desc(schema.agentEvents.seq))
      .limit(bounded);
    // We fetched newest-first; flip to ascending seq for the caller so
    // consumers can iterate in event-log order like the legacy driver does.
    return rows.reverse().map(rowToEvent);
  }

  // ---------- Burn goals ----------
  async getBurnGoalByConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<BurnGoalRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.burnGoals)
      .where(
        and(
          eq(schema.burnGoals.workspaceId, workspaceId),
          eq(schema.burnGoals.conversationId, conversationId)
        )
      )
      .limit(1);
    return row ? rowToBurnGoal(row) : null;
  }

  async upsertBurnGoal(record: BurnGoalRecord): Promise<void> {
    const values = {
      goalId: record.goalId,
      workspaceId: record.workspaceId,
      conversationId: record.conversationId,
      schemaVersion: record.schemaVersion,
      objective: record.objective,
      status: record.status,
      phase: record.phase,
      tokenBudget: record.tokenBudget,
      tokensUsed: record.tokensUsed,
      timeUsedSeconds: record.timeUsedSeconds,
      payload: burnGoalPayload(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
    };
    await getDb()
      .insert(schema.burnGoals)
      .values(values)
      .onConflictDoUpdate({
        target: schema.burnGoals.conversationId,
        set: {
          objective: values.objective,
          status: values.status,
          phase: values.phase,
          tokenBudget: values.tokenBudget,
          tokensUsed: values.tokensUsed,
          timeUsedSeconds: values.timeUsedSeconds,
          payload: values.payload,
          updatedAt: values.updatedAt,
          completedAt: values.completedAt,
        },
      });
  }

  async updateBurnGoal(
    workspaceId: string,
    conversationId: string,
    patch: BurnGoalPatch
  ): Promise<BurnGoalRecord | null> {
    const current = await this.getBurnGoalByConversation(workspaceId, conversationId);
    if (!current) {
      return null;
    }
    const next: BurnGoalRecord = {
      ...current,
      ...patch,
      revision:
        patch.revision !== undefined
          ? patch.revision
          : current.revision + 1,
      updatedAt: Date.now(),
    };
    await this.upsertBurnGoal(next);
    return next;
  }

  async listBurnGoals(workspaceId: string): Promise<BurnGoalRecord[]> {
    const rows = await getDb()
      .select()
      .from(schema.burnGoals)
      .where(eq(schema.burnGoals.workspaceId, workspaceId))
      .orderBy(desc(schema.burnGoals.updatedAt));
    return rows.map(rowToBurnGoal);
  }

  // ---------- VS Code extensions ----------
  async listInstalledExtensions(workspaceId: string): Promise<ExtensionInstallRecord[]> {
    const rows = await getDb()
      .select()
      .from(schema.extensionInstalls)
      .where(eq(schema.extensionInstalls.workspaceId, workspaceId))
      .orderBy(desc(schema.extensionInstalls.updatedAt));
    return rows.map(rowToExtensionInstall);
  }

  async getInstalledExtension(
    workspaceId: string,
    extensionId: string
  ): Promise<ExtensionInstallRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.extensionInstalls)
      .where(
        and(
          eq(schema.extensionInstalls.workspaceId, workspaceId),
          eq(schema.extensionInstalls.extensionId, extensionId.toLowerCase())
        )
      )
      .limit(1);
    return row ? rowToExtensionInstall(row) : null;
  }

  async upsertInstalledExtension(record: ExtensionInstallRecord): Promise<void> {
    await getDb()
      .insert(schema.extensionInstalls)
      .values({
        workspaceId: record.workspaceId,
        extensionId: record.extensionId.toLowerCase(),
        enabled: record.enabled,
        publisher: record.publisher,
        name: record.name,
        version: record.version,
        compatibility: record.compatibility,
        payload: record,
        createdAt: record.installedAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.extensionInstalls.workspaceId,
          schema.extensionInstalls.extensionId,
        ],
        set: {
          enabled: record.enabled,
          publisher: record.publisher,
          name: record.name,
          version: record.version,
          compatibility: record.compatibility,
          payload: record,
          updatedAt: record.updatedAt,
        },
      });
  }

  async deleteInstalledExtension(
    workspaceId: string,
    extensionId: string
  ): Promise<boolean> {
    const deleted = await getDb()
      .delete(schema.extensionInstalls)
      .where(
        and(
          eq(schema.extensionInstalls.workspaceId, workspaceId),
          eq(schema.extensionInstalls.extensionId, extensionId.toLowerCase())
        )
      )
      .returning({ extensionId: schema.extensionInstalls.extensionId });
    return deleted.length > 0;
  }

  async patchExtensionSettings(
    workspaceId: string,
    extensionId: string,
    settings: Record<string, unknown>
  ): Promise<ExtensionInstallRecord | null> {
    const record = await this.getInstalledExtension(workspaceId, extensionId);
    if (!record) {
      return null;
    }
    const next: ExtensionInstallRecord = {
      ...record,
      settings: {
        ...record.settings,
        ...settings,
      },
      updatedAt: Date.now(),
    };
    await this.upsertInstalledExtension(next);
    return next;
  }

  async upsertExtensionPermissionGrant(grant: ExtensionPermissionGrant): Promise<void> {
    const record = await this.getInstalledExtension(grant.workspaceId, grant.extensionId);
    if (!record) {
      throw new Error(`Unknown extension: ${grant.extensionId}`);
    }
    const grants = record.permissions.filter((existing) => existing.id !== grant.id);
    grants.push(grant);
    await this.upsertInstalledExtension({
      ...record,
      permissions: grants,
      updatedAt: Date.now(),
    });
  }

  // ---------- provider cache ----------
  async readProviderCache(
    backendId: AgentBackendId
  ): Promise<AgentProviderCacheRecord | null> {
    const [row] = await getDb()
      .select()
      .from(schema.providerCache)
      .where(eq(schema.providerCache.backendId, backendId))
      .limit(1);
    if (!row) return null;
    const configOptions = (row.payload ?? []) as AgentConfigOption[];
    if (!Array.isArray(configOptions) || configOptions.length === 0) return null;
    return {
      schemaVersion: 1,
      backendId: row.backendId as AgentBackendId,
      updatedAt: row.fetchedAt,
      configOptions,
    };
  }

  async writeProviderCache(
    backendId: AgentBackendId,
    record: AgentProviderCacheRecord
  ): Promise<void> {
    const payload = record.configOptions ?? [];
    await getDb()
      .insert(schema.providerCache)
      .values({
        backendId,
        schemaVersion: record.schemaVersion ?? 1,
        payload: payload as unknown as unknown[],
        fetchedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.providerCache.backendId,
        set: {
          schemaVersion: record.schemaVersion ?? 1,
          payload: payload as unknown as unknown[],
          fetchedAt: record.updatedAt,
        },
      });
  }

  // ---------- orchestration ----------
  async listOrchestrationBoards(
    workspaceId: string
  ): Promise<OrchestrationBoardListResult> {
    const rows = await getDb()
      .select()
      .from(schema.orchestrationBoards)
      .where(
        and(
          eq(schema.orchestrationBoards.workspaceId, workspaceId),
          sql`${schema.orchestrationBoards.archivedAt} IS NULL`
        )
      )
      .orderBy(desc(schema.orchestrationBoards.updatedAt));
    return { boards: rows.map(rowToOrchestrationBoard) };
  }

  async getOrchestrationBoardSnapshot(
    boardId: string
  ): Promise<OrchestrationBoardSnapshot | null> {
    const db = getDb();
    const [boardRow] = await db
      .select()
      .from(schema.orchestrationBoards)
      .where(eq(schema.orchestrationBoards.id, boardId))
      .limit(1);
    if (!boardRow) {
      return null;
    }
    const [issueRows, assignmentRows, eventRows] = await Promise.all([
      db
        .select()
        .from(schema.orchestrationIssues)
        .where(eq(schema.orchestrationIssues.boardId, boardId))
        .orderBy(
          asc(schema.orchestrationIssues.columnId),
          asc(schema.orchestrationIssues.sortOrder)
        ),
      db
        .select()
        .from(schema.orchestrationAssignments)
        .where(eq(schema.orchestrationAssignments.boardId, boardId))
        .orderBy(asc(schema.orchestrationAssignments.createdAt)),
      db
        .select()
        .from(schema.orchestrationEvents)
        .where(eq(schema.orchestrationEvents.boardId, boardId))
        .orderBy(asc(schema.orchestrationEvents.createdAt)),
    ]);
    return {
      board: rowToOrchestrationBoard(boardRow),
      issues: issueRows.map(rowToOrchestrationIssue),
      assignments: assignmentRows.map(rowToOrchestrationAssignment),
      events: eventRows.map(rowToOrchestrationEvent),
    };
  }

  async saveOrchestrationBoardSnapshot(
    snapshot: OrchestrationBoardSnapshot
  ): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.orchestrationBoards)
        .values({
          id: snapshot.board.id,
          workspaceId: snapshot.board.workspaceId,
          schemaVersion: snapshot.board.schemaVersion,
          title: snapshot.board.title,
          description: snapshot.board.description,
          headConversationId: snapshot.board.headConversationId,
          createdAt: snapshot.board.createdAt,
          updatedAt: snapshot.board.updatedAt,
          archivedAt: snapshot.board.archivedAt,
          settings: snapshot.board.settings as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: schema.orchestrationBoards.id,
          set: {
            title: snapshot.board.title,
            description: snapshot.board.description,
            headConversationId: snapshot.board.headConversationId,
            updatedAt: snapshot.board.updatedAt,
            archivedAt: snapshot.board.archivedAt,
            settings: snapshot.board.settings as unknown as Record<string, unknown>,
          },
        });

      await tx
        .delete(schema.orchestrationEvents)
        .where(eq(schema.orchestrationEvents.boardId, snapshot.board.id));
      await tx
        .delete(schema.orchestrationAssignments)
        .where(eq(schema.orchestrationAssignments.boardId, snapshot.board.id));
      await tx
        .delete(schema.orchestrationIssues)
        .where(eq(schema.orchestrationIssues.boardId, snapshot.board.id));

      if (snapshot.issues.length > 0) {
        await tx.insert(schema.orchestrationIssues).values(
          snapshot.issues.map((issue) => ({
            id: issue.id,
            boardId: issue.boardId,
            schemaVersion: issue.schemaVersion,
            title: issue.title,
            description: issue.description,
            columnId: issue.columnId,
            priority: issue.priority,
            sortOrder: issue.sortOrder,
            acceptanceCriteria: issue.acceptanceCriteria,
            dependencyIssueIds: issue.dependencyIssueIds,
            blockedReason: issue.blockedReason,
            verification: issue.verification as unknown as Record<string, unknown>,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            completedAt: issue.completedAt,
          }))
        );
      }

      if (snapshot.assignments.length > 0) {
        await tx.insert(schema.orchestrationAssignments).values(
          snapshot.assignments.map((assignment) => ({
            id: assignment.id,
            boardId: assignment.boardId,
            issueId: assignment.issueId,
            conversationId: assignment.conversationId,
            schemaVersion: assignment.schemaVersion,
            role: assignment.role,
            status: assignment.status,
            createdAt: assignment.createdAt,
            updatedAt: assignment.updatedAt,
            config: assignment.config as unknown as Record<string, unknown>,
            lastKnownConversationStatus: assignment.lastKnownConversationStatus,
          }))
        );
      }

      if (snapshot.events.length > 0) {
        await tx.insert(schema.orchestrationEvents).values(
          snapshot.events.map((event) => ({
            id: event.id,
            boardId: event.boardId,
            issueId: event.issueId,
            assignmentId: event.assignmentId,
            schemaVersion: event.schemaVersion,
            kind: event.kind,
            actor: event.actor as unknown as Record<string, unknown>,
            message: event.message,
            payload: event.payload,
            createdAt: event.createdAt,
          }))
        );
      }
    });
  }

  async deleteOrchestrationBoard(boardId: string): Promise<void> {
    await getDb()
      .delete(schema.orchestrationBoards)
      .where(eq(schema.orchestrationBoards.id, boardId));
  }
}

/**
 * Shared upsert path for workspace-level and window-level sessions. Both rows
 * live in the same table; the caller chooses the row by passing a window id
 * (use the empty sentinel for the workspace-level session). Revision checks
 * are applied only when `expectedRevision` is provided.
 */
async function upsertSessionWithRevision(params: {
  workspaceId: string;
  windowId: string;
  payload: PersistedWorkspaceSession;
  expectedRevision?: number;
}): Promise<{ revision: number }> {
  const { workspaceId, windowId, payload, expectedRevision } = params;
  const db = getDb();
  const now = Date.now();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        revision: schema.workspaceSessions.revision,
      })
      .from(schema.workspaceSessions)
      .where(
        and(
          eq(schema.workspaceSessions.workspaceId, workspaceId),
          eq(schema.workspaceSessions.windowId, windowId)
        )
      )
      .for("update");

    if (!existing) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new StorageConflictError(
          "workspace_sessions revision mismatch (row does not exist)",
          { expectedRevision, actualRevision: 0 }
        );
      }
      await tx.insert(schema.workspaceSessions).values({
        workspaceId,
        windowId,
        payload: payload as unknown as Record<string, unknown>,
        revision: 1,
        updatedAt: now,
      });
      return { revision: 1 };
    }

    if (
      expectedRevision !== undefined &&
      expectedRevision !== existing.revision
    ) {
      throw new StorageConflictError(
        `workspace_sessions revision mismatch (expected ${expectedRevision}, actual ${existing.revision})`,
        { expectedRevision, actualRevision: existing.revision }
      );
    }

    const nextRevision = existing.revision + 1;
    await tx
      .update(schema.workspaceSessions)
      .set({
        payload: payload as unknown as Record<string, unknown>,
        revision: nextRevision,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.workspaceSessions.workspaceId, workspaceId),
          eq(schema.workspaceSessions.windowId, windowId)
        )
      );
    return { revision: nextRevision };
  });
}

// Re-export helpers so phase 3 write implementations can reuse them.
export { buildEventPayload, encodeCursor, decodeCursor };
