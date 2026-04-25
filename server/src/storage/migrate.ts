import { LegacyJsonStorageDriver } from "./legacy/index.js";
import { PgStorageDriver } from "./pg/index.js";
import type { StorageDriver, StorageDriverKind } from "./driver.js";
import type { AgentBackendId } from "../lib/agents/types.js";

const ALL_BACKEND_IDS: AgentBackendId[] = [
  "cursor-acp",
  "opencode-acp",
  "gemini-acp",
  "codex-adapter",
  "claude-adapter",
];

/**
 * Phases run in the listed order. Downstream phases depend on earlier ones
 * (workspaces must exist before workspace-sessions; conversations before
 * events; etc.), so do not reshuffle casually.
 */
export type MigrationPhase =
  | "workspaces"
  | "workspace-profile"
  | "global-settings"
  | "auth-state"
  | "auth-sessions"
  | "workspace-sessions"
  | "workspace-windows"
  | "workspace-window-sessions"
  | "agent-conversations"
  | "agent-events"
  | "provider-cache";

export const ALL_MIGRATION_PHASES: MigrationPhase[] = [
  "workspaces",
  "workspace-profile",
  "global-settings",
  "auth-state",
  "auth-sessions",
  "workspace-sessions",
  "workspace-windows",
  "workspace-window-sessions",
  "agent-conversations",
  "agent-events",
  "provider-cache",
];

export type MigrationProgressEvent = {
  phase: MigrationPhase;
  /** Number of entries processed so far in the current phase. */
  completed: number;
  /**
   * Total entries in the current phase when known upfront; null for streamed
   * phases where the total is discovered incrementally (events).
   */
  total: number | null;
  /** Identifier of the entry most recently handled, for UI breadcrumbs. */
  currentKey?: string;
};

export type MigrationPhaseReport = {
  phase: MigrationPhase;
  migrated: number;
  skipped: number;
  errors: Array<{ key: string; message: string }>;
};

export type MigrationCheckpoint = {
  phase: MigrationPhase;
  /** Phases that completed successfully in this run (or a previous resumed run). */
  completedPhases: MigrationPhase[];
  /** Opaque phase-specific resume token (e.g. list cursor). */
  phaseCursor?: string;
};

export type MigrationOptions = {
  from: StorageDriverKind;
  to: StorageDriverKind;
  /**
   * When true, overwrite data that already exists on the target. When false
   * (default), phases that detect existing target data are skipped with a
   * warning so callers can review before forcing the migration.
   */
  overwrite?: boolean;
  /** Restrict the run to a subset of phases. Defaults to all phases. */
  phases?: MigrationPhase[];
  /** Batch size for streamed event copies. Defaults to 500 events per batch. */
  eventBatchSize?: number;
  /** Batch size for conversation list pagination. Defaults to 200. */
  conversationBatchSize?: number;
  onProgress?: (event: MigrationProgressEvent) => void;
  checkpoint?: MigrationCheckpoint;
  onCheckpoint?: (checkpoint: MigrationCheckpoint) => Promise<void> | void;
};

export type MigrationResult = {
  ok: boolean;
  fromDriver: StorageDriverKind;
  toDriver: StorageDriverKind;
  overwrite: boolean;
  phases: MigrationPhaseReport[];
  /** Checkpoint at the end of the run (useful for resuming or auditing). */
  checkpoint: MigrationCheckpoint;
};

export type MigrationStats = {
  driver: StorageDriverKind;
  workspaces: number;
  agentConversations: number;
  authSessions: number;
  providerCacheEntries: number;
  hasGlobalSettings: boolean;
  hasAuthState: boolean;
};

function instantiateDriver(kind: StorageDriverKind): StorageDriver {
  switch (kind) {
    case "legacy-json":
      return new LegacyJsonStorageDriver();
    case "pg":
      return new PgStorageDriver();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unreachable storage driver kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Instantiate + initialize a fresh driver for one side of a migration. The
 * caller owns lifecycle and must `close()` it when done.
 */
export async function openDriver(kind: StorageDriverKind): Promise<StorageDriver> {
  const driver = instantiateDriver(kind);
  await driver.init();
  return driver;
}

/** Quick counts for the Settings UI and CLI `status` subcommand. */
export async function gatherStats(driver: StorageDriver): Promise<MigrationStats> {
  const [workspaces, authSessions, globalSettings, authState] = await Promise.all([
    driver.listWorkspaces(),
    driver.listAuthSessions(),
    driver.getGlobalSettings(),
    driver.getAuthState(),
  ]);

  let agentConversations = 0;
  let cursor: string | null | undefined = null;
  while (true) {
    const page = await driver.listAgentConversations({
      cursor,
      limit: 500,
      includeArchived: true,
    });
    agentConversations += page.records.length;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  let providerCacheEntries = 0;
  for (const backendId of ALL_BACKEND_IDS) {
    const entry = await driver.readProviderCache(backendId);
    if (entry) providerCacheEntries += 1;
  }

  return {
    driver: driver.kind,
    workspaces: workspaces.length,
    agentConversations,
    authSessions: authSessions.length,
    providerCacheEntries,
    hasGlobalSettings: globalSettings !== null,
    hasAuthState: authState !== null,
  };
}

type PhaseContext = {
  from: StorageDriver;
  to: StorageDriver;
  overwrite: boolean;
  emitProgress: (event: Omit<MigrationProgressEvent, "phase">) => void;
  eventBatchSize: number;
  conversationBatchSize: number;
};

async function migrateWorkspaces(ctx: PhaseContext): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  const workspaces = await ctx.from.listWorkspaces();
  let migrated = 0;
  let skipped = 0;

  const existingIds = new Set(
    ctx.overwrite ? [] : (await ctx.to.listWorkspaces()).map((w) => w.id)
  );

  for (let i = 0; i < workspaces.length; i++) {
    const record = workspaces[i];
    ctx.emitProgress({
      completed: i,
      total: workspaces.length,
      currentKey: record.id,
    });
    if (!ctx.overwrite && existingIds.has(record.id)) {
      skipped += 1;
      continue;
    }
    try {
      await ctx.to.upsertWorkspace(record);
      migrated += 1;
    } catch (error) {
      errors.push({ key: record.id, message: (error as Error).message });
    }
  }
  ctx.emitProgress({
    completed: workspaces.length,
    total: workspaces.length,
  });
  return { phase: "workspaces", migrated, skipped, errors };
}

async function migrateWorkspaceProfile(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  let skipped = 0;
  ctx.emitProgress({ completed: 0, total: 1 });
  const source = await ctx.from.getWorkspaceProfile();
  if (!ctx.overwrite) {
    const current = await ctx.to.getWorkspaceProfile();
    if (current && Object.keys(current).length > 0) {
      skipped = 1;
      ctx.emitProgress({ completed: 1, total: 1 });
      return { phase: "workspace-profile", migrated, skipped, errors };
    }
  }
  try {
    await ctx.to.saveWorkspaceProfile(source);
    migrated = 1;
  } catch (error) {
    errors.push({ key: "profile", message: (error as Error).message });
  }
  ctx.emitProgress({ completed: 1, total: 1 });
  return { phase: "workspace-profile", migrated, skipped, errors };
}

async function migrateGlobalSettings(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  let skipped = 0;
  ctx.emitProgress({ completed: 0, total: 1 });
  const source = await ctx.from.getGlobalSettings();
  if (!source) {
    skipped = 1;
    ctx.emitProgress({ completed: 1, total: 1 });
    return { phase: "global-settings", migrated, skipped, errors };
  }
  if (!ctx.overwrite) {
    const current = await ctx.to.getGlobalSettings();
    if (current !== null) {
      skipped = 1;
      ctx.emitProgress({ completed: 1, total: 1 });
      return { phase: "global-settings", migrated, skipped, errors };
    }
  }
  try {
    await ctx.to.saveGlobalSettings(source);
    migrated = 1;
  } catch (error) {
    errors.push({ key: "global", message: (error as Error).message });
  }
  ctx.emitProgress({ completed: 1, total: 1 });
  return { phase: "global-settings", migrated, skipped, errors };
}

async function migrateAuthState(ctx: PhaseContext): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  let skipped = 0;
  ctx.emitProgress({ completed: 0, total: 1 });
  const source = await ctx.from.getAuthState();
  if (!source) {
    skipped = 1;
    ctx.emitProgress({ completed: 1, total: 1 });
    return { phase: "auth-state", migrated, skipped, errors };
  }
  if (!ctx.overwrite) {
    const current = await ctx.to.getAuthState();
    if (current !== null) {
      skipped = 1;
      ctx.emitProgress({ completed: 1, total: 1 });
      return { phase: "auth-state", migrated, skipped, errors };
    }
  }
  try {
    await ctx.to.saveAuthState(source);
    migrated = 1;
  } catch (error) {
    errors.push({ key: "auth-state", message: (error as Error).message });
  }
  ctx.emitProgress({ completed: 1, total: 1 });
  return { phase: "auth-state", migrated, skipped, errors };
}

async function migrateAuthSessions(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  ctx.emitProgress({ completed: 0, total: 1 });
  const sessions = await ctx.from.listAuthSessions();
  let skipped = 0;
  if (!ctx.overwrite) {
    const existing = await ctx.to.listAuthSessions();
    if (existing.length > 0) {
      skipped = sessions.length;
      ctx.emitProgress({ completed: 1, total: 1 });
      return { phase: "auth-sessions", migrated: 0, skipped, errors };
    }
  }
  try {
    await ctx.to.saveAuthSessions(sessions);
    ctx.emitProgress({ completed: 1, total: 1 });
    return {
      phase: "auth-sessions",
      migrated: sessions.length,
      skipped,
      errors,
    };
  } catch (error) {
    errors.push({ key: "auth-sessions", message: (error as Error).message });
    ctx.emitProgress({ completed: 1, total: 1 });
    return { phase: "auth-sessions", migrated: 0, skipped, errors };
  }
}

async function migrateWorkspaceSessions(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  const workspaces = await ctx.from.listWorkspaces();
  let migrated = 0;
  let skipped = 0;
  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    ctx.emitProgress({
      completed: i,
      total: workspaces.length,
      currentKey: ws.id,
    });
    const source = await ctx.from.getWorkspaceSession(ws.id);
    if (!source) {
      skipped += 1;
      continue;
    }
    if (!ctx.overwrite) {
      const existing = await ctx.to.getWorkspaceSession(ws.id);
      if (existing) {
        skipped += 1;
        continue;
      }
    }
    try {
      await ctx.to.saveWorkspaceSession(ws.id, source);
      migrated += 1;
    } catch (error) {
      errors.push({ key: ws.id, message: (error as Error).message });
    }
  }
  ctx.emitProgress({
    completed: workspaces.length,
    total: workspaces.length,
  });
  return { phase: "workspace-sessions", migrated, skipped, errors };
}

async function migrateWorkspaceWindows(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  const workspaces = await ctx.from.listWorkspaces();
  let migrated = 0;
  let skipped = 0;
  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    ctx.emitProgress({
      completed: i,
      total: workspaces.length,
      currentKey: ws.id,
    });
    const windows = await ctx.from.listWorkspaceWindows(ws.id);
    if (windows.length === 0) {
      skipped += 1;
      continue;
    }
    if (!ctx.overwrite) {
      const existing = await ctx.to.listWorkspaceWindows(ws.id);
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }
    }
    try {
      await ctx.to.saveWorkspaceWindows(ws.id, windows);
      migrated += windows.length;
    } catch (error) {
      errors.push({ key: ws.id, message: (error as Error).message });
    }
  }
  ctx.emitProgress({
    completed: workspaces.length,
    total: workspaces.length,
  });
  return { phase: "workspace-windows", migrated, skipped, errors };
}

async function migrateWorkspaceWindowSessions(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  const workspaces = await ctx.from.listWorkspaces();
  let migrated = 0;
  let skipped = 0;
  let visited = 0;
  let totalWindows = 0;
  for (const ws of workspaces) {
    totalWindows += (await ctx.from.listWorkspaceWindows(ws.id)).length;
  }
  for (const ws of workspaces) {
    const windows = await ctx.from.listWorkspaceWindows(ws.id);
    for (const w of windows) {
      ctx.emitProgress({
        completed: visited,
        total: totalWindows,
        currentKey: `${ws.id}/${w.id}`,
      });
      visited += 1;
      const source = await ctx.from.getWorkspaceWindowSession(ws.id, w.id);
      if (!source) {
        skipped += 1;
        continue;
      }
      if (!ctx.overwrite) {
        const existing = await ctx.to.getWorkspaceWindowSession(ws.id, w.id);
        if (existing) {
          skipped += 1;
          continue;
        }
      }
      try {
        await ctx.to.saveWorkspaceWindowSession(ws.id, w.id, source);
        migrated += 1;
      } catch (error) {
        errors.push({
          key: `${ws.id}/${w.id}`,
          message: (error as Error).message,
        });
      }
    }
  }
  ctx.emitProgress({
    completed: totalWindows,
    total: totalWindows,
  });
  return { phase: "workspace-window-sessions", migrated, skipped, errors };
}

async function migrateAgentConversations(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  let skipped = 0;
  let processed = 0;

  const existingIds = new Set<string>();
  if (!ctx.overwrite) {
    let cursor: string | null | undefined = null;
    while (true) {
      const page = await ctx.to.listAgentConversations({
        cursor,
        limit: ctx.conversationBatchSize,
        includeArchived: true,
      });
      for (const record of page.records) existingIds.add(record.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  let cursor: string | null | undefined = null;
  while (true) {
    const page = await ctx.from.listAgentConversations({
      cursor,
      limit: ctx.conversationBatchSize,
      includeArchived: true,
    });
    for (const record of page.records) {
      ctx.emitProgress({
        completed: processed,
        total: null,
        currentKey: record.id,
      });
      processed += 1;
      if (!ctx.overwrite && existingIds.has(record.id)) {
        skipped += 1;
        continue;
      }
      try {
        await ctx.to.upsertAgentConversation(record);
        migrated += 1;
      } catch (error) {
        errors.push({ key: record.id, message: (error as Error).message });
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  ctx.emitProgress({ completed: processed, total: processed });
  return { phase: "agent-conversations", migrated, skipped, errors };
}

async function migrateAgentEvents(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  const skipped = 0;

  // Walk conversations on source, streaming events for each.
  const conversationIds: string[] = [];
  let cursor: string | null | undefined = null;
  while (true) {
    const page = await ctx.from.listAgentConversations({
      cursor,
      limit: ctx.conversationBatchSize,
      includeArchived: true,
    });
    for (const record of page.records) conversationIds.push(record.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const totalConversations = conversationIds.length;
  for (let i = 0; i < conversationIds.length; i++) {
    const conversationId = conversationIds[i];
    ctx.emitProgress({
      completed: i,
      total: totalConversations,
      currentKey: conversationId,
    });

    let targetLastSeq = 0;
    if (!ctx.overwrite) {
      const existing = await ctx.to.getAgentConversation(conversationId);
      targetLastSeq = existing?.lastEventSeq ?? 0;
    }

    let afterSeq = ctx.overwrite ? 0 : targetLastSeq;
    while (true) {
      const batch = await ctx.from.readAgentEvents({
        conversationId,
        afterSeq,
        limit: ctx.eventBatchSize,
      });
      if (batch.length === 0) break;
      try {
        const events = batch.map((event) => {
          const { seq: _seq, ...rest } = event;
          return rest as unknown as Parameters<
            StorageDriver["appendAgentEvents"]
          >[0]["events"][number];
        });
        await ctx.to.appendAgentEvents({
          conversationId,
          events,
        });
        migrated += batch.length;
      } catch (error) {
        errors.push({
          key: `${conversationId}@${afterSeq}`,
          message: (error as Error).message,
        });
        break;
      }
      afterSeq = batch[batch.length - 1].seq;
      if (batch.length < ctx.eventBatchSize) break;
    }
  }

  ctx.emitProgress({
    completed: totalConversations,
    total: totalConversations,
  });
  return { phase: "agent-events", migrated, skipped, errors };
}

async function migrateProviderCache(
  ctx: PhaseContext
): Promise<MigrationPhaseReport> {
  const errors: MigrationPhaseReport["errors"] = [];
  let migrated = 0;
  let skipped = 0;
  for (let i = 0; i < ALL_BACKEND_IDS.length; i++) {
    const backendId = ALL_BACKEND_IDS[i];
    ctx.emitProgress({
      completed: i,
      total: ALL_BACKEND_IDS.length,
      currentKey: backendId,
    });
    const source = await ctx.from.readProviderCache(backendId);
    if (!source) {
      skipped += 1;
      continue;
    }
    if (!ctx.overwrite) {
      const existing = await ctx.to.readProviderCache(backendId);
      if (existing) {
        skipped += 1;
        continue;
      }
    }
    try {
      await ctx.to.writeProviderCache(backendId, source);
      migrated += 1;
    } catch (error) {
      errors.push({ key: backendId, message: (error as Error).message });
    }
  }
  ctx.emitProgress({
    completed: ALL_BACKEND_IDS.length,
    total: ALL_BACKEND_IDS.length,
  });
  return { phase: "provider-cache", migrated, skipped, errors };
}

const PHASE_HANDLERS: Record<
  MigrationPhase,
  (ctx: PhaseContext) => Promise<MigrationPhaseReport>
> = {
  workspaces: migrateWorkspaces,
  "workspace-profile": migrateWorkspaceProfile,
  "global-settings": migrateGlobalSettings,
  "auth-state": migrateAuthState,
  "auth-sessions": migrateAuthSessions,
  "workspace-sessions": migrateWorkspaceSessions,
  "workspace-windows": migrateWorkspaceWindows,
  "workspace-window-sessions": migrateWorkspaceWindowSessions,
  "agent-conversations": migrateAgentConversations,
  "agent-events": migrateAgentEvents,
  "provider-cache": migrateProviderCache,
};

/**
 * Copy data from one storage driver to another. The function is
 * self-contained and instantiates both drivers itself so callers can run it
 * outside a live server (CLI, first-boot helper) without bootstrapping the
 * global singleton.
 *
 * Idempotency: with `overwrite: false` (default) rows that already exist on
 * the target are skipped. With `overwrite: true` the migration overwrites the
 * target, which is useful when flipping directions during testing.
 */
export async function migrate(options: MigrationOptions): Promise<MigrationResult> {
  if (options.from === options.to) {
    throw new Error("Migration source and target must be different drivers.");
  }
  const overwrite = options.overwrite ?? false;
  const phases = options.phases ?? ALL_MIGRATION_PHASES;
  const eventBatchSize = options.eventBatchSize ?? 500;
  const conversationBatchSize = options.conversationBatchSize ?? 200;

  const from = await openDriver(options.from);
  const to = await openDriver(options.to);

  const reports: MigrationPhaseReport[] = [];
  const completedPhases: MigrationPhase[] = options.checkpoint?.completedPhases ?? [];
  let finalCheckpoint: MigrationCheckpoint = {
    phase: phases[0] ?? "workspaces",
    completedPhases,
  };

  try {
    for (const phase of phases) {
      if (completedPhases.includes(phase)) {
        continue;
      }
      finalCheckpoint = { phase, completedPhases: [...completedPhases] };
      await options.onCheckpoint?.(finalCheckpoint);
      const handler = PHASE_HANDLERS[phase];
      const ctx: PhaseContext = {
        from,
        to,
        overwrite,
        emitProgress: (event) => {
          options.onProgress?.({ phase, ...event });
        },
        eventBatchSize,
        conversationBatchSize,
      };
      const report = await handler(ctx);
      reports.push(report);
      completedPhases.push(phase);
      finalCheckpoint = { phase, completedPhases: [...completedPhases] };
      await options.onCheckpoint?.(finalCheckpoint);
    }
  } finally {
    await Promise.allSettled([from.close(), to.close()]);
  }

  const ok = reports.every((r) => r.errors.length === 0);
  return {
    ok,
    fromDriver: options.from,
    toDriver: options.to,
    overwrite,
    phases: reports,
    checkpoint: finalCheckpoint,
  };
}
