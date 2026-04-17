import { promises as fs } from "node:fs";
import path from "node:path";
import * as legacyFs from "../../lib/agents/session-store-legacy-fs.js";
import {
  DATA_DIR,
  readJsonFile,
  writeJsonFile,
} from "../../lib/persistence.js";
import { sortWorkspaceRecords } from "../../lib/workspace-sort.js";
import {
  getWorkspaceSessionFile,
  getWorkspaceWindowRegistryFile,
  getWorkspaceWindowSessionFile,
} from "../../lib/workspace-session-paths.js";
import type {
  AgentBackendId,
  AgentConversationRecord,
  AgentEventInput,
  AgentStoredEvent,
} from "../../lib/agents/types.js";
import type { GlobalSettings } from "../../lib/global-settings-store.js";
import type { WorkspaceProfileFile, WorkspaceRecord } from "../../lib/workspace-registry.js";
import type {
  PersistedWorkspaceSession,
  WorkspaceWindowRecord,
} from "../../lib/workspace-session-store.js";
import type {
  AgentProviderCacheRecord,
  AppendAgentEventsInput,
  ListAgentConversationsInput,
  ListAgentConversationsResult,
  ReadAgentEventsInput,
  StorageDriver,
} from "../driver.js";

/**
 * JSON-on-disk storage driver. Implements `StorageDriver` without calling
 * `workspace-registry` / `session-store` (those modules delegate here via
 * `getStorage()`), avoiding circular imports.
 */

const WORKSPACES_INDEX_FILE = path.join(DATA_DIR, "workspaces", "index.json");
const WORKSPACE_PROFILE_FILE = path.join(
  DATA_DIR,
  "profile",
  "workspace-profile.json"
);
const GLOBAL_SETTINGS_FILE = path.join(DATA_DIR, "profile", "global-settings.json");
const AUTH_STATE_FILE = path.join(DATA_DIR, "profile", "auth-state.json");
const AUTH_SESSIONS_FILE = path.join(DATA_DIR, "profile", "auth-sessions.json");

function getProviderCacheFile(backendId: string): string {
  return path.join(DATA_DIR, "profile", "agent-backends", `${backendId}.json`);
}

type WorkspaceRegistryFile = {
  schemaVersion: number;
  workspaces: WorkspaceRecord[];
};

type PersistedAuthState = {
  schemaVersion: 1;
  createdAt: number;
  updatedAt?: number;
  secret: string;
};

type PersistedAuthSessionsFile = {
  schemaVersion: 1;
  sessions: Array<{
    id: string;
    username: string;
    createdAt: number;
    lastSeenAt: number;
    lastRotatedAt: number;
    expiresAt: number;
    remember: boolean;
  }>;
};

const EMPTY_REGISTRY: WorkspaceRegistryFile = {
  schemaVersion: 1,
  workspaces: [],
};

const EMPTY_PROFILE: WorkspaceProfileFile = {
  schemaVersion: 1,
  defaultWorkspaceId: null,
  lastOpenedWorkspaceId: null,
  recentWorkspaceIds: [],
};

type PersistedWorkspaceWindowRegistry = {
  schemaVersion: 1;
  windows: WorkspaceWindowRecord[];
};

function normalizeWorkspaceWindowRecords(raw: unknown): WorkspaceWindowRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value): value is WorkspaceWindowRecord => {
      if (!value || typeof value !== "object") {
        return false;
      }
      const record = value as Partial<WorkspaceWindowRecord>;
      return (
        typeof record.id === "string" &&
        record.id.length > 0 &&
        typeof record.workspaceId === "string" &&
        record.workspaceId.length > 0 &&
        typeof record.label === "string" &&
        record.label.length > 0 &&
        typeof record.createdAt === "number" &&
        Number.isFinite(record.createdAt) &&
        typeof record.updatedAt === "number" &&
        Number.isFinite(record.updatedAt) &&
        typeof record.lastOpenedAt === "number" &&
        Number.isFinite(record.lastOpenedAt)
      );
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function readRegistry(): Promise<WorkspaceRegistryFile> {
  const registryFile = await readJsonFile(WORKSPACES_INDEX_FILE, EMPTY_REGISTRY);
  return {
    schemaVersion: 1,
    workspaces: Array.isArray(registryFile.workspaces)
      ? registryFile.workspaces
      : [],
  };
}

async function writeRegistry(next: WorkspaceRegistryFile): Promise<void> {
  await writeJsonFile(WORKSPACES_INDEX_FILE, next);
}

export class LegacyJsonStorageDriver implements StorageDriver {
  readonly kind = "legacy-json" as const;

  async init(): Promise<void> {
    // mkdir -p happens lazily via persistence helpers.
  }

  async close(): Promise<void> {
    // No resources to tear down.
  }

  // ---------- workspaces ----------
  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const current = await readRegistry();
    return sortWorkspaceRecords(current.workspaces);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const current = await readRegistry();
    return current.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  async getWorkspaceByRoot(root: string): Promise<WorkspaceRecord | null> {
    const current = await readRegistry();
    return current.workspaces.find((workspace) => workspace.root === root) ?? null;
  }

  async upsertWorkspace(record: WorkspaceRecord): Promise<void> {
    const current = await readRegistry();
    const next = current.workspaces.some((workspace) => workspace.id === record.id)
      ? current.workspaces.map((workspace) =>
          workspace.id === record.id ? record : workspace
        )
      : [...current.workspaces, record];
    await writeRegistry({ schemaVersion: 1, workspaces: next });
  }

  async deleteWorkspace(id: string): Promise<void> {
    const current = await readRegistry();
    await writeRegistry({
      schemaVersion: 1,
      workspaces: current.workspaces.filter((workspace) => workspace.id !== id),
    });
    const workspaceDir = path.join(DATA_DIR, "workspaces", id);
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(
      () => undefined
    );
  }

  async getWorkspaceProfile(): Promise<WorkspaceProfileFile> {
    const profile = await readJsonFile(WORKSPACE_PROFILE_FILE, EMPTY_PROFILE);
    return {
      schemaVersion: 1,
      defaultWorkspaceId:
        typeof profile.defaultWorkspaceId === "string"
          ? profile.defaultWorkspaceId
          : null,
      lastOpenedWorkspaceId:
        typeof profile.lastOpenedWorkspaceId === "string"
          ? profile.lastOpenedWorkspaceId
          : null,
      recentWorkspaceIds: Array.isArray(profile.recentWorkspaceIds)
        ? profile.recentWorkspaceIds.filter(
            (value): value is string => typeof value === "string"
          )
        : [],
    };
  }

  async saveWorkspaceProfile(profile: WorkspaceProfileFile): Promise<void> {
    await writeJsonFile(WORKSPACE_PROFILE_FILE, profile);
  }

  // ---------- workspace sessions + windows ----------
  async getWorkspaceSession(
    workspaceId: string
  ): Promise<PersistedWorkspaceSession | null> {
    const session = await readJsonFile<PersistedWorkspaceSession | null>(
      getWorkspaceSessionFile(workspaceId),
      null
    );
    if (!session || session.schemaVersion !== 1) {
      return null;
    }
    return session;
  }

  async saveWorkspaceSession(
    workspaceId: string,
    session: PersistedWorkspaceSession
  ): Promise<{ revision: number }> {
    await writeJsonFile(getWorkspaceSessionFile(workspaceId), session);
    return { revision: 0 };
  }

  async listWorkspaceWindows(
    workspaceId: string
  ): Promise<WorkspaceWindowRecord[]> {
    const registry = await readJsonFile<PersistedWorkspaceWindowRegistry | null>(
      getWorkspaceWindowRegistryFile(workspaceId),
      null
    );
    if (!registry || registry.schemaVersion !== 1) {
      return [];
    }
    return normalizeWorkspaceWindowRecords(registry.windows);
  }

  async saveWorkspaceWindows(
    workspaceId: string,
    windows: WorkspaceWindowRecord[]
  ): Promise<void> {
    await writeJsonFile(getWorkspaceWindowRegistryFile(workspaceId), {
      schemaVersion: 1,
      windows,
    } satisfies PersistedWorkspaceWindowRegistry);
  }

  async getWorkspaceWindowSession(
    workspaceId: string,
    windowId: string
  ): Promise<PersistedWorkspaceSession | null> {
    const session = await readJsonFile<PersistedWorkspaceSession | null>(
      getWorkspaceWindowSessionFile(workspaceId, windowId),
      null
    );
    if (!session || session.schemaVersion !== 1) {
      return null;
    }
    return session;
  }

  async saveWorkspaceWindowSession(
    workspaceId: string,
    windowId: string,
    session: PersistedWorkspaceSession
  ): Promise<{ revision: number }> {
    await writeJsonFile(
      getWorkspaceWindowSessionFile(workspaceId, windowId),
      session
    );
    return { revision: 0 };
  }

  // ---------- global settings ----------
  async getGlobalSettings(): Promise<GlobalSettings | null> {
    const raw = await readJsonFile<GlobalSettings | null>(
      GLOBAL_SETTINGS_FILE,
      null
    );
    if (!raw || raw.schemaVersion !== 1) {
      return null;
    }
    return raw;
  }

  async saveGlobalSettings(
    settings: GlobalSettings
  ): Promise<{ revision: number }> {
    await writeJsonFile(GLOBAL_SETTINGS_FILE, settings);
    return { revision: 0 };
  }

  // ---------- auth ----------
  async getAuthState(): Promise<{
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  } | null> {
    const raw = await readJsonFile<PersistedAuthState | null>(
      AUTH_STATE_FILE,
      null
    );
    if (!raw || typeof raw.secret !== "string" || raw.secret.length === 0) {
      return null;
    }
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      secret: raw.secret,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt:
        typeof raw.updatedAt === "number"
          ? raw.updatedAt
          : raw.createdAt ?? Date.now(),
    };
  }

  async saveAuthState(state: {
    schemaVersion: number;
    secret: string;
    createdAt: number;
    updatedAt: number;
  }): Promise<void> {
    await writeJsonFile(AUTH_STATE_FILE, {
      schemaVersion: 1,
      secret: state.secret,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    } satisfies PersistedAuthState);
  }

  async listAuthSessions(): Promise<PersistedAuthSessionsFile["sessions"]> {
    const raw = await readJsonFile<PersistedAuthSessionsFile | null>(
      AUTH_SESSIONS_FILE,
      null
    );
    if (!raw || !Array.isArray(raw.sessions)) return [];
    const now = Date.now();
    return raw.sessions.filter((session) => session.expiresAt > now);
  }

  async saveAuthSessions(
    sessions: PersistedAuthSessionsFile["sessions"]
  ): Promise<void> {
    const store: PersistedAuthSessionsFile = {
      schemaVersion: 1,
      sessions,
    };
    await writeJsonFile(AUTH_SESSIONS_FILE, store);
  }

  // ---------- agent conversations ----------
  async listAgentConversations(
    input: ListAgentConversationsInput
  ): Promise<ListAgentConversationsResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));

    let pool: AgentConversationRecord[];
    if (input.workspaceId) {
      pool = await legacyFs.legacyFsListWorkspaceConversationRecords(
        input.workspaceId
      );
    } else {
      const { workspaces } = await readRegistry();
      const perWorkspace = await Promise.all(
        workspaces.map((workspace) =>
          legacyFs.legacyFsListWorkspaceConversationRecords(workspace.id)
        )
      );
      pool = perWorkspace.flat();
    }

    const filtered = input.includeArchived
      ? pool
      : pool.filter((record) => !record.archivedAt);
    filtered.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
    );

    const offset = Number.parseInt(input.cursor ?? "0", 10) || 0;
    const window = filtered.slice(offset, offset + limit);
    const nextCursor =
      offset + window.length < filtered.length
        ? String(offset + window.length)
        : null;
    return { records: window, nextCursor };
  }

  async getAgentConversation(
    id: string
  ): Promise<AgentConversationRecord | null> {
    const { workspaces } = await readRegistry();
    for (const workspace of workspaces) {
      const record = await legacyFs.legacyFsReadConversationRecord(
        workspace.id,
        id
      );
      if (record) return record;
    }
    return null;
  }

  async upsertAgentConversation(record: AgentConversationRecord): Promise<void> {
    await legacyFs.legacyFsSaveConversationMeta(record);
  }

  async deleteAgentConversation(id: string): Promise<void> {
    const existing = await this.getAgentConversation(id);
    if (!existing) return;
    await legacyFs.legacyFsDeleteConversationDir(existing.workspaceId, id);
  }

  async appendAgentEvents(
    input: AppendAgentEventsInput
  ): Promise<{ events: AgentStoredEvent[]; newLastSeq: number }> {
    if (input.events.length === 0) {
      return { events: [], newLastSeq: 0 };
    }
    const conversationId = input.conversationId;
    const existing = await this.getAgentConversation(conversationId);
    if (!existing) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const appended = await legacyFs.legacyFsAppendConversationEvents(
      existing.workspaceId,
      conversationId,
      input.events as AgentEventInput[]
    );
    const last = appended[appended.length - 1];
    return {
      events: appended,
      newLastSeq: last?.seq ?? existing.lastEventSeq,
    };
  }

  async readAgentEvents(input: ReadAgentEventsInput): Promise<AgentStoredEvent[]> {
    const existing = await this.getAgentConversation(input.conversationId);
    if (!existing) return [];
    const after = input.afterSeq ?? 0;
    const events = await legacyFs.legacyFsReadConversationEventsSince(
      existing.workspaceId,
      input.conversationId,
      after
    );
    if (typeof input.limit === "number" && input.limit > 0) {
      return events.slice(0, input.limit);
    }
    return events;
  }

  async readAgentEventsOlderThan(input: {
    conversationId: string;
    beforeSeq: number;
    limit: number;
  }): Promise<AgentStoredEvent[]> {
    const existing = await this.getAgentConversation(input.conversationId);
    if (!existing) return [];
    const all = await legacyFs.legacyFsReadConversationEvents(
      existing.workspaceId,
      input.conversationId
    );
    const older = all.filter((e) => e.seq < input.beforeSeq);
    const cap = Math.max(1, Math.min(input.limit, 100_000));
    if (older.length <= cap) {
      return older;
    }
    return older.slice(-cap);
  }

  async readRecentAgentEvents(
    conversationId: string,
    limit: number
  ): Promise<AgentStoredEvent[]> {
    const existing = await this.getAgentConversation(conversationId);
    if (!existing) return [];
    const all = await legacyFs.legacyFsReadConversationEvents(
      existing.workspaceId,
      conversationId
    );
    if (limit <= 0 || all.length <= limit) return all;
    return all.slice(-limit);
  }

  // ---------- provider cache ----------
  async readProviderCache(
    backendId: AgentBackendId
  ): Promise<AgentProviderCacheRecord | null> {
    const raw = await readJsonFile<AgentProviderCacheRecord | null>(
      getProviderCacheFile(backendId),
      null
    );
    if (
      !raw ||
      raw.schemaVersion !== 1 ||
      raw.backendId !== backendId ||
      !Array.isArray(raw.configOptions) ||
      raw.configOptions.length === 0
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      backendId,
      updatedAt: raw.updatedAt ?? Date.now(),
      configOptions: raw.configOptions,
    };
  }

  async writeProviderCache(
    backendId: AgentBackendId,
    record: AgentProviderCacheRecord
  ): Promise<void> {
    if (!record.configOptions || record.configOptions.length === 0) return;
    await writeJsonFile(getProviderCacheFile(backendId), {
      schemaVersion: 1,
      backendId,
      updatedAt: record.updatedAt,
      configOptions: record.configOptions,
    } satisfies AgentProviderCacheRecord);
  }
}
