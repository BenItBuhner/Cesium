import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  availableDriverKinds,
  bootstrapFixtureEnv,
  createFixture,
} from "./helpers/storage-fixture.js";
import type { StorageDriverKind } from "../src/storage/driver.js";
import type {
  AgentConversationRecord,
  AgentProviderCapabilities,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

/**
 * Parameterized storage-driver test fixture. Exercises the read path of
 * every StorageDriver against the same scenarios, verifying both the
 * legacy-json and pg backends behave identically.
 *
 * pg subtests only run when DATABASE_URL_TEST (or DATABASE_URL) is set and
 * points at a reachable Postgres 16 instance whose schema matches the
 * drizzle migration under server/src/db/migrations.
 */

const testCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: true,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: false,
};

function makeWorkspace(
  overrides: Partial<WorkspaceRecord> = {}
): WorkspaceRecord {
  const now = Date.now();
  return {
    id: overrides.id ?? `ws-${randomUUID().slice(0, 8)}`,
    name: overrides.name ?? "Test Workspace",
    root: overrides.root ?? `/tmp/opencursor-${randomUUID().slice(0, 8)}`,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastOpenedAt: overrides.lastOpenedAt ?? now,
  };
}

function makeConversation(
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: overrides.id ?? `conv-${randomUUID().slice(0, 8)}`,
    workspaceId: overrides.workspaceId ?? "ws-fixture",
    title: overrides.title ?? "Fixture Conversation",
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastEventSeq: overrides.lastEventSeq ?? 0,
    lastReadSeq: overrides.lastReadSeq ?? 0,
    config: overrides.config ?? {
      backendId: "cursor-acp",
      mode: "agent",
      modelId: "test-fast",
      modelName: "Test Fast",
    },
    providerSessionId: overrides.providerSessionId ?? null,
    configOptions: overrides.configOptions ?? [],
    capabilities: overrides.capabilities ?? testCapabilities,
    pendingPermission: overrides.pendingPermission ?? null,
    lastError: overrides.lastError ?? null,
    experimental: overrides.experimental ?? false,
    archivedAt: overrides.archivedAt ?? null,
  };
}

async function seedWorkspaces(
  kind: StorageDriverKind,
  workspaces: WorkspaceRecord[]
): Promise<void> {
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(path.join(DATA_DIR, "workspaces", "index.json"), {
      schemaVersion: 1,
      workspaces,
    });
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    if (workspaces.length === 0) return;
    await getDb()
      .insert(schema.workspaces)
      .values(
        workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          root: workspace.root,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          lastOpenedAt: workspace.lastOpenedAt,
        }))
      );
  }
}

async function seedGlobalSettings(
  kind: StorageDriverKind,
  payload: Record<string, unknown>
): Promise<void> {
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(
      path.join(DATA_DIR, "profile", "global-settings.json"),
      payload
    );
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    await getDb()
      .insert(schema.globalSettings)
      .values({
        id: 1,
        payload,
        revision: 1,
        updatedAt: Date.now(),
      });
  }
}

async function seedWorkspaceProfile(
  kind: StorageDriverKind,
  profile: {
    defaultWorkspaceId: string | null;
    lastOpenedWorkspaceId: string | null;
    recentWorkspaceIds: string[];
  }
): Promise<void> {
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(
      path.join(DATA_DIR, "profile", "workspace-profile.json"),
      {
        schemaVersion: 1,
        ...profile,
      }
    );
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    await getDb()
      .insert(schema.workspaceProfile)
      .values({
        id: 1,
        defaultWorkspaceId: profile.defaultWorkspaceId,
        lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
        recentWorkspaceIds: profile.recentWorkspaceIds,
        updatedAt: Date.now(),
      });
  }
}

async function seedAuthState(
  kind: StorageDriverKind,
  secret: string
): Promise<void> {
  const now = Date.now();
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(path.join(DATA_DIR, "profile", "auth-state.json"), {
      schemaVersion: 1,
      secret,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    await getDb()
      .insert(schema.authState)
      .values({
        id: 1,
        schemaVersion: 1,
        secret,
        createdAt: now,
        updatedAt: now,
      });
  }
}

async function seedAuthSessions(
  kind: StorageDriverKind,
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
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(path.join(DATA_DIR, "profile", "auth-sessions.json"), {
      schemaVersion: 1,
      sessions,
    });
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    if (sessions.length === 0) return;
    await getDb().insert(schema.authSessions).values(sessions);
  }
}

async function seedConversation(
  kind: StorageDriverKind,
  record: AgentConversationRecord
): Promise<void> {
  if (kind === "legacy-json") {
    const [{ writeJsonFile, DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    await writeJsonFile(
      path.join(
        DATA_DIR,
        "workspaces",
        record.workspaceId,
        "conversations",
        record.id,
        "meta.json"
      ),
      record
    );
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    await getDb()
      .insert(schema.agentConversations)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        schemaVersion: 1,
        title: record.title,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastEventSeq: record.lastEventSeq,
        lastReadSeq: record.lastReadSeq,
        config: record.config,
        providerSessionId: record.providerSessionId,
        configOptions: record.configOptions,
        capabilities: record.capabilities,
        pendingPermission: record.pendingPermission,
        lastError: record.lastError,
        experimental: record.experimental,
        archivedAt: record.archivedAt,
      });
  }
}

async function seedEvents(
  kind: StorageDriverKind,
  workspaceId: string,
  conversationId: string,
  events: AgentStoredEvent[]
): Promise<void> {
  if (kind === "legacy-json") {
    const [{ DATA_DIR }] = await Promise.all([
      import("../src/lib/persistence.js"),
    ]);
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = path.join(
      DATA_DIR,
      "workspaces",
      workspaceId,
      "conversations",
      conversationId
    );
    await fs.mkdir(dir, { recursive: true });
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    await fs.writeFile(path.join(dir, "events.jsonl"), `${body}\n`, "utf8");
  } else {
    const [{ getDb }, schema] = await Promise.all([
      import("../src/db/client.js"),
      import("../src/db/schema.js"),
    ]);
    if (events.length === 0) return;
    await getDb()
      .insert(schema.agentEvents)
      .values(
        events.map((event) => {
          const {
            seq,
            eventId,
            kind: eventKind,
            createdAt,
            conversationId: _cid,
            ...rest
          } = event;
          return {
            conversationId,
            seq,
            eventId,
            kind: eventKind,
            payload: rest as Record<string, unknown>,
            createdAt,
          };
        })
      );
  }
}

const DRIVERS = availableDriverKinds();

for (const kind of DRIVERS) {
  test(`storage[${kind}]: reads work end-to-end`, async (t) => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    after(async () => fixture.cleanup());

    await t.test("listWorkspaces returns Home-first ordering", async () => {
      const home = makeWorkspace({
        id: "home",
        name: "Home",
        root: "/home/user",
        lastOpenedAt: 100,
      });
      const projectA = makeWorkspace({
        id: "project-a",
        name: "Alpha",
        root: "/home/user/alpha",
        lastOpenedAt: 200,
      });
      const projectB = makeWorkspace({
        id: "project-b",
        name: "Bravo",
        root: "/home/user/bravo",
        lastOpenedAt: 300,
      });
      await seedWorkspaces(kind, [projectA, home, projectB]);

      const list = await fixture.driver.listWorkspaces();
      assert.equal(list.length, 3);
      assert.equal(list[0]!.name, "Home");
      assert.deepEqual(
        list.slice(1).map((workspace) => workspace.id),
        ["project-b", "project-a"]
      );

      const byId = await fixture.driver.getWorkspace("project-a");
      assert.equal(byId?.name, "Alpha");

      const byRoot = await fixture.driver.getWorkspaceByRoot("/home/user/bravo");
      assert.equal(byRoot?.id, "project-b");

      const missing = await fixture.driver.getWorkspace("nope");
      assert.equal(missing, null);
    });

    await t.test("workspace profile round-trips via reads", async () => {
      await seedWorkspaceProfile(kind, {
        defaultWorkspaceId: "project-a",
        lastOpenedWorkspaceId: "project-b",
        recentWorkspaceIds: ["project-b", "project-a", "home"],
      });
      const profile = await fixture.driver.getWorkspaceProfile();
      assert.equal(profile.defaultWorkspaceId, "project-a");
      assert.equal(profile.lastOpenedWorkspaceId, "project-b");
      assert.deepEqual(profile.recentWorkspaceIds, [
        "project-b",
        "project-a",
        "home",
      ]);
    });

    await t.test("global settings reads", async () => {
      await seedGlobalSettings(kind, {
        schemaVersion: 1,
        theme: "dark",
        layout: { rail: "left", pane: true },
      });
      const settings = await fixture.driver.getGlobalSettings();
      assert.ok(settings, "expected global settings to exist");
      const raw = settings as unknown as Record<string, unknown>;
      assert.equal(raw.theme, "dark");
    });

    await t.test("auth state + session filtering", async () => {
      await seedAuthState(kind, "secret-abc-123");
      const now = Date.now();
      await seedAuthSessions(kind, [
        {
          id: "sess-live",
          username: "alice",
          createdAt: now - 60_000,
          lastSeenAt: now,
          lastRotatedAt: now,
          expiresAt: now + 60_000,
          remember: true,
        },
        {
          id: "sess-expired",
          username: "alice",
          createdAt: now - 7 * 24 * 60 * 60 * 1000,
          lastSeenAt: now - 2 * 60 * 60 * 1000,
          lastRotatedAt: now - 2 * 60 * 60 * 1000,
          expiresAt: now - 60_000,
          remember: false,
        },
      ]);

      const state = await fixture.driver.getAuthState();
      assert.equal(state?.secret, "secret-abc-123");

      const sessions = await fixture.driver.listAuthSessions();
      assert.equal(sessions.length, 1, "expired sessions must be filtered out");
      assert.equal(sessions[0]!.id, "sess-live");
    });

    await t.test("agent conversations: keyset pagination", async () => {
      const workspaceId = "project-a";
      const now = Date.now();
      const conversations = Array.from({ length: 5 }, (_, i) =>
        makeConversation({
          id: `conv-${i}`,
          workspaceId,
          title: `Conversation ${i}`,
          updatedAt: now - i * 1000,
          createdAt: now - i * 1000,
        })
      );
      for (const conv of conversations) {
        await seedConversation(kind, conv);
      }

      const firstPage = await fixture.driver.listAgentConversations({
        workspaceId,
        limit: 2,
      });
      assert.equal(firstPage.records.length, 2);
      assert.equal(firstPage.records[0]!.id, "conv-0");
      assert.equal(firstPage.records[1]!.id, "conv-1");
      assert.ok(firstPage.nextCursor, "expected a next cursor");

      const secondPage = await fixture.driver.listAgentConversations({
        workspaceId,
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      assert.equal(secondPage.records.length, 2);
      assert.equal(secondPage.records[0]!.id, "conv-2");
      assert.equal(secondPage.records[1]!.id, "conv-3");

      const thirdPage = await fixture.driver.listAgentConversations({
        workspaceId,
        limit: 2,
        cursor: secondPage.nextCursor,
      });
      assert.equal(thirdPage.records.length, 1);
      assert.equal(thirdPage.records[0]!.id, "conv-4");
      assert.equal(thirdPage.nextCursor, null);

      const single = await fixture.driver.getAgentConversation("conv-2");
      assert.equal(single?.title, "Conversation 2");
    });

    await t.test("agent events: read tail + ascending order", async () => {
      const conversationId = "conv-events";
      await seedConversation(
        kind,
        makeConversation({
          id: conversationId,
          workspaceId: "project-a",
          lastEventSeq: 3,
        })
      );
      const base = Date.now();
      const events: AgentStoredEvent[] = [
        {
          seq: 1,
          eventId: "e1",
          conversationId,
          createdAt: base,
          kind: "user_message",
          messageId: "m1",
          content: "Hello",
        },
        {
          seq: 2,
          eventId: "e2",
          conversationId,
          createdAt: base + 1000,
          kind: "assistant_message_chunk",
          messageId: "m2",
          text: "Hi there",
        },
        {
          seq: 3,
          eventId: "e3",
          conversationId,
          createdAt: base + 2000,
          kind: "assistant_message_end",
          messageId: "m2",
        },
      ];
      await seedEvents(kind, "project-a", conversationId, events);

      const all = await fixture.driver.readAgentEvents({ conversationId });
      assert.equal(all.length, 3);
      assert.deepEqual(
        all.map((event) => event.seq),
        [1, 2, 3]
      );

      const sinceOne = await fixture.driver.readAgentEvents({
        conversationId,
        afterSeq: 1,
      });
      assert.equal(sinceOne.length, 2);
      assert.equal(sinceOne[0]!.seq, 2);

      const tail = await fixture.driver.readRecentAgentEvents(conversationId, 2);
      assert.equal(tail.length, 2);
      assert.equal(tail[0]!.seq, 2);
      assert.equal(tail[1]!.seq, 3);
    });
  });
}

for (const kind of DRIVERS) {
  test(`storage[${kind}]: writes + optimistic concurrency`, async (t) => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    after(async () => fixture.cleanup());

    await t.test("upsertWorkspace round-trips and updates fields", async () => {
      const workspace = makeWorkspace({
        id: "ws-write-1",
        name: "Original",
        root: "/tmp/ws-write-1",
      });
      await fixture.driver.upsertWorkspace(workspace);
      const loaded = await fixture.driver.getWorkspace("ws-write-1");
      assert.equal(loaded?.name, "Original");

      await fixture.driver.upsertWorkspace({
        ...workspace,
        name: "Renamed",
        lastOpenedAt: workspace.lastOpenedAt + 1000,
      });
      const reloaded = await fixture.driver.getWorkspace("ws-write-1");
      assert.equal(reloaded?.name, "Renamed");
      assert.equal(reloaded?.lastOpenedAt, workspace.lastOpenedAt + 1000);
    });

    await t.test("saveWorkspaceProfile overwrites existing profile", async () => {
      await fixture.driver.saveWorkspaceProfile({
        schemaVersion: 1,
        defaultWorkspaceId: "ws-write-1",
        lastOpenedWorkspaceId: "ws-write-1",
        recentWorkspaceIds: ["ws-write-1"],
      });
      const afterFirst = await fixture.driver.getWorkspaceProfile();
      assert.equal(afterFirst.defaultWorkspaceId, "ws-write-1");

      await fixture.driver.saveWorkspaceProfile({
        schemaVersion: 1,
        defaultWorkspaceId: null,
        lastOpenedWorkspaceId: null,
        recentWorkspaceIds: [],
      });
      const afterSecond = await fixture.driver.getWorkspaceProfile();
      assert.equal(afterSecond.defaultWorkspaceId, null);
      assert.deepEqual(afterSecond.recentWorkspaceIds, []);
    });

    await t.test(
      "saveGlobalSettings returns revision + enforces expectedRevision on pg",
      async () => {
        const first = await fixture.driver.saveGlobalSettings({
          schemaVersion: 1,
          theme: "dark",
        } as never);
        const second = await fixture.driver.saveGlobalSettings({
          schemaVersion: 1,
          theme: "light",
        } as never);

        if (kind === "pg") {
          // pg maintains a monotonic revision across writes and enforces
          // expectedRevision; legacy ignores revisions and always returns 0.
          assert.ok(first.revision >= 1, "pg first revision should be >= 1");
          assert.ok(
            second.revision > first.revision,
            "pg second revision should strictly increase"
          );
          const { StorageConflictError } = await import(
            "../src/storage/driver.js"
          );
          await assert.rejects(
            fixture.driver.saveGlobalSettings(
              { schemaVersion: 1, theme: "high-contrast" } as never,
              second.revision - 1
            ),
            (err) =>
              err instanceof StorageConflictError &&
              err.expectedRevision === second.revision - 1
          );
        } else {
          assert.equal(
            first.revision,
            0,
            "legacy revision is a no-op and stays 0"
          );
          assert.equal(second.revision, 0);
        }

        const loaded = await fixture.driver.getGlobalSettings();
        assert.equal(
          (loaded as unknown as Record<string, unknown>).theme,
          "light"
        );
      }
    );

    await t.test("saveAuthState + saveAuthSessions round-trip", async () => {
      const now = Date.now();
      await fixture.driver.saveAuthState({
        schemaVersion: 1,
        secret: "s-1",
        createdAt: now,
        updatedAt: now,
      });
      const state1 = await fixture.driver.getAuthState();
      assert.equal(state1?.secret, "s-1");

      await fixture.driver.saveAuthState({
        schemaVersion: 1,
        secret: "s-2",
        createdAt: now,
        updatedAt: now + 100,
      });
      const state2 = await fixture.driver.getAuthState();
      assert.equal(state2?.secret, "s-2");

      await fixture.driver.saveAuthSessions([
        {
          id: "sess-write",
          username: "bob",
          createdAt: now,
          lastSeenAt: now,
          lastRotatedAt: now,
          expiresAt: now + 120_000,
          remember: false,
        },
      ]);
      const liveSessions = await fixture.driver.listAuthSessions();
      assert.equal(liveSessions.length, 1);
      assert.equal(liveSessions[0]?.id, "sess-write");

      // Wholesale replace: passing an empty array should wipe everything.
      await fixture.driver.saveAuthSessions([]);
      const emptySessions = await fixture.driver.listAuthSessions();
      assert.equal(emptySessions.length, 0);
    });

    await t.test(
      "upsert conversation + appendAgentEvents bumps lastEventSeq",
      async () => {
        const convId = "conv-write-1";
        const convWorkspaceId = "ws-write-1";
        await fixture.driver.upsertAgentConversation(
          makeConversation({
            id: convId,
            workspaceId: convWorkspaceId,
            title: "Writer",
          })
        );

        const base = Date.now();
        const appended = await fixture.driver.appendAgentEvents({
          conversationId: convId,
          events: [
            {
              eventId: "ew1",
              conversationId: convId,
              kind: "user_message",
              messageId: "mw1",
              content: "Hi",
              createdAt: base,
            },
            {
              eventId: "ew2",
              conversationId: convId,
              kind: "assistant_message_chunk",
              messageId: "mw2",
              text: "Hello",
              createdAt: base + 10,
            },
          ],
        });
        assert.equal(appended.events.length, 2);
        assert.equal(appended.newLastSeq, 2);
        assert.equal(appended.events[0]!.seq, 1);
        assert.equal(appended.events[1]!.seq, 2);

        const reloaded = await fixture.driver.getAgentConversation(convId);
        assert.equal(reloaded?.lastEventSeq, 2);

        const stored = await fixture.driver.readAgentEvents({
          conversationId: convId,
        });
        assert.equal(stored.length, 2);
        assert.deepEqual(
          stored.map((event) => event.seq),
          [1, 2]
        );

        // Second append continues the sequence, no resets.
        const followUp = await fixture.driver.appendAgentEvents({
          conversationId: convId,
          events: [
            {
              eventId: "ew3",
              conversationId: convId,
              kind: "assistant_message_end",
              messageId: "mw2",
              createdAt: base + 20,
            },
          ],
        });
        assert.equal(followUp.newLastSeq, 3);

        await fixture.driver.deleteAgentConversation(convId);
        const gone = await fixture.driver.getAgentConversation(convId);
        assert.equal(gone, null);
        const zombieEvents = await fixture.driver.readAgentEvents({
          conversationId: convId,
        });
        assert.equal(zombieEvents.length, 0);
      }
    );

    await t.test("writeProviderCache round-trips", async () => {
      await fixture.driver.writeProviderCache("cursor-acp", {
        schemaVersion: 1,
        backendId: "cursor-acp",
        updatedAt: Date.now(),
        configOptions: [
          { id: "gpt-alpha", name: "GPT Alpha", kind: "model" } as never,
        ],
      });
      const cached = await fixture.driver.readProviderCache("cursor-acp");
      assert.ok(cached, "expected provider cache to exist");
      assert.equal(cached?.configOptions.length, 1);
    });
  });
}
