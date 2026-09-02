import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { clientKeyValueStore } from "@cesium/client";
import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "../src/lib/agent-types.ts";
import {
  CONVERSATION_CATALOG_STORAGE_KEY,
  MAX_CATALOG_PAYLOAD_CHARS,
  annotateRailGroupsForServer,
  buildConversationCatalog,
  cloudRowToCatalog,
  conversationCatalogServerKey,
  conversationCatalogSignature,
  mergeCloudCatalogsIntoStore,
  parseConversationCatalogPayload,
  readConversationCatalogStore,
  removeConversationCatalog,
  resolveOfflineCatalogGroups,
  serializeConversationCatalogPayload,
  trimCatalogGroupsToFit,
  upsertConversationCatalog,
} from "../src/lib/conversation-catalog.ts";

function summary(
  id: string,
  overrides: Partial<AgentRailConversationSummary> = {}
): AgentRailConversationSummary {
  return {
    id,
    workspaceId: "ws-1",
    title: `Conversation ${id}`,
    createdAt: 1_000,
    updatedAt: 2_000,
    lastEventSeq: 3,
    status: "idle",
    archivedAt: null,
    backendId: "cesium-agent",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    ...overrides,
  } as AgentRailConversationSummary;
}

function group(
  workspaceId: string,
  conversations: AgentRailConversationSummary[],
  overrides: Partial<AgentConversationGroup> = {}
): AgentConversationGroup {
  return {
    workspace: {
      id: workspaceId,
      name: `Workspace ${workspaceId}`,
      root: `/workspaces/${workspaceId}`,
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    },
    conversations,
    ...overrides,
  } as AgentConversationGroup;
}

const codespaceServer = {
  id: "local-1",
  label: "octo/repo",
  baseUrl: "https://fluffy-space-1234-9100.app.github.dev",
};
const codespaceDevices = [
  { baseUrl: "https://FLUFFY-space-1234-9100.app.github.dev/", repoFullName: "octo/repo" },
];

describe("conversation catalog identity", () => {
  test("codespace pairings are keyed by repo, everything else by connection key", () => {
    assert.equal(
      conversationCatalogServerKey(codespaceServer, codespaceDevices),
      "codespace:octo/repo"
    );
    assert.equal(
      conversationCatalogServerKey({ baseUrl: "http://192.168.4.172:9100/" }, codespaceDevices),
      "url:http://192.168.4.172:9100"
    );
    assert.equal(conversationCatalogServerKey({ baseUrl: "not a url" }), null);
  });
});

describe("conversation catalog building", () => {
  test("strips device-local annotations and records counts + freshness", () => {
    const annotated = annotateRailGroupsForServer(
      [group("ws-1", [summary("a", { updatedAt: 5_000 }), summary("b", { updatedAt: 9_000 })])],
      codespaceServer
    );
    assert.equal(annotated[0]?.serverId, "local-1");
    assert.equal(annotated[0]?.conversations[0]?.conversationKey, "local-1:a");

    const catalog = buildConversationCatalog({
      serverKey: "codespace:octo/repo",
      server: codespaceServer,
      groups: annotated,
      now: 123,
    });
    assert.equal(catalog.conversationCount, 2);
    assert.equal(catalog.sourceUpdatedAt, 9_000);
    assert.equal(catalog.updatedAt, 123);
    assert.equal(catalog.serverName, "octo/repo");
    const stored = catalog.groups[0]!;
    assert.equal("serverId" in stored, false);
    assert.equal("workspaceKey" in stored, false);
    assert.equal("serverId" in stored.conversations[0]!, false);
    assert.equal("conversationKey" in stored.conversations[0]!, false);
    // Payload round-trips through the cloud wire format.
    const payload = serializeConversationCatalogPayload(catalog);
    assert.deepEqual(parseConversationCatalogPayload(payload), catalog.groups);
    assert.equal(parseConversationCatalogPayload("{}"), null);
    assert.equal(parseConversationCatalogPayload("garbage"), null);
    assert.ok(conversationCatalogSignature(catalog).startsWith("codespace:octo/repo\u00002\u00009000"));
  });

  test("trims the oldest conversations to fit the payload ceiling", () => {
    const conversations = Array.from({ length: 400 }, (_, index) =>
      summary(`c${index}`, {
        updatedAt: 1_000 + index,
        title: "x".repeat(200),
      })
    );
    const trimmed = trimCatalogGroupsToFit([group("ws-1", conversations)], 20_000);
    const remaining = trimmed[0]!.conversations;
    assert.ok(remaining.length > 0);
    assert.ok(remaining.length < 400);
    assert.ok(JSON.stringify(trimmed).length <= 20_000);
    // Newest survive.
    assert.equal(remaining.at(-1)?.id, "c399");
    assert.ok(remaining.every((row) => row.updatedAt > 1_000 + (400 - remaining.length) - 1));
    // Default ceiling leaves realistic listings untouched.
    const small = [group("ws-1", conversations.slice(0, 50))];
    assert.deepEqual(trimCatalogGroupsToFit(small), small);
    assert.ok(MAX_CATALOG_PAYLOAD_CHARS > JSON.stringify(small).length);
  });

  test("keeps emptied groups so the workspace still appears", () => {
    const trimmed = trimCatalogGroupsToFit(
      [group("ws-1", [summary("a", { title: "x".repeat(500) })])],
      300
    );
    assert.equal(trimmed.length, 1);
    assert.equal(trimmed[0]!.conversations.length, 0);
  });
});

describe("conversation catalog local store", () => {
  beforeEach(() => {
    clientKeyValueStore().removeItem(CONVERSATION_CATALOG_STORAGE_KEY);
  });

  test("upserts by server key, newer capture wins, removal works", () => {
    const first = buildConversationCatalog({
      serverKey: "url:http://a:9100",
      server: { label: "A", baseUrl: "http://a:9100" },
      groups: [group("ws-1", [summary("a")])],
      now: 10,
    });
    upsertConversationCatalog(first);
    assert.deepEqual(Object.keys(readConversationCatalogStore()), ["url:http://a:9100"]);

    const stale = { ...first, updatedAt: 5, conversationCount: 99 };
    upsertConversationCatalog(stale);
    assert.equal(readConversationCatalogStore()["url:http://a:9100"]?.conversationCount, 1);

    const fresher = { ...first, updatedAt: 20, conversationCount: 2 };
    upsertConversationCatalog(fresher);
    assert.equal(readConversationCatalogStore()["url:http://a:9100"]?.conversationCount, 2);

    removeConversationCatalog("url:http://a:9100");
    assert.deepEqual(readConversationCatalogStore(), {});
  });

  test("ignores corrupt or foreign-version storage", () => {
    clientKeyValueStore().setItem(CONVERSATION_CATALOG_STORAGE_KEY, "{not json");
    assert.deepEqual(readConversationCatalogStore(), {});
    clientKeyValueStore().setItem(
      CONVERSATION_CATALOG_STORAGE_KEY,
      JSON.stringify({ version: 99, catalogs: { x: {} } })
    );
    assert.deepEqual(readConversationCatalogStore(), {});
  });

  test("merges cloud rows when they are newer than the local copy", () => {
    const local = buildConversationCatalog({
      serverKey: "codespace:octo/repo",
      server: codespaceServer,
      groups: [group("ws-1", [summary("a")])],
      now: 100,
    });
    const cloudNewer = {
      serverKey: "codespace:octo/repo",
      serverName: "octo/repo",
      baseUrl: codespaceServer.baseUrl,
      payload: serializeConversationCatalogPayload({
        ...local,
        groups: [group("ws-1", [summary("a"), summary("b")])],
      }),
      conversationCount: 2,
      sourceUpdatedAt: 2_000,
      updatedAt: 200,
    };
    const cloudOlder = { ...cloudNewer, serverKey: "url:http://b:9100", updatedAt: 50 };
    const cloudBroken = { ...cloudNewer, serverKey: "url:http://c:9100", payload: "nope" };
    const merged = mergeCloudCatalogsIntoStore(
      { [local.serverKey]: local, "url:http://b:9100": { ...local, serverKey: "url:http://b:9100" } },
      [cloudNewer, cloudOlder, cloudBroken]
    );
    assert.equal(merged.changed, true);
    assert.equal(merged.store["codespace:octo/repo"]?.conversationCount, 2);
    assert.equal(merged.store["url:http://b:9100"]?.updatedAt, 100);
    assert.equal("url:http://c:9100" in merged.store, false);
    assert.equal(cloudRowToCatalog(cloudBroken), null);

    const unchanged = mergeCloudCatalogsIntoStore(merged.store, [cloudNewer]);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.store, merged.store);
  });
});

describe("offline catalog projection", () => {
  test("restores cached groups only for servers that did not answer", () => {
    const catalog = buildConversationCatalog({
      serverKey: "codespace:octo/repo",
      server: codespaceServer,
      groups: [
        group("ws-1", [
          summary("running", { status: "running", updatedAt: 9 }),
          summary("perm", {
            status: "awaiting_permission",
            hasPendingPermission: true,
            pendingPermissionTitle: "Run command",
          }),
          summary("done", { status: "idle" }),
        ]),
      ],
      now: 42,
    });
    const otherServer = { id: "local-2", label: "Desk", baseUrl: "http://192.168.4.172:9100" };
    const groups = resolveOfflineCatalogGroups({
      servers: [codespaceServer, otherServer],
      fetchedServerIds: new Set(["local-2"]),
      store: { [catalog.serverKey]: catalog },
      serverKeyFor: (server) => conversationCatalogServerKey(server, codespaceDevices),
    });
    assert.equal(groups.length, 1);
    const restored = groups[0]!;
    assert.equal(restored.serverOffline, true);
    assert.equal(restored.serverCachedAt, 42);
    assert.equal(restored.serverId, "local-1");
    assert.equal(restored.workspaceKey, "local-1:ws-1");
    assert.equal(restored.conversations.length, 3);
    // A sleeping engine has no live runtimes: busy states collapse to
    // interrupted and pending prompts are cleared so the rail never spins.
    const byId = new Map(restored.conversations.map((row) => [row.id, row]));
    assert.equal(byId.get("running")?.status, "interrupted");
    assert.equal(byId.get("perm")?.status, "interrupted");
    assert.equal(byId.get("perm")?.hasPendingPermission, false);
    assert.equal(byId.get("perm")?.pendingPermissionTitle, null);
    assert.equal(byId.get("done")?.status, "idle");
    assert.ok(restored.conversations.every((row) => row.serverOffline === true));
    assert.equal(byId.get("done")?.conversationKey, "local-1:done");
  });

  test("servers without a catalog produce nothing", () => {
    const groups = resolveOfflineCatalogGroups({
      servers: [codespaceServer],
      fetchedServerIds: new Set(),
      store: {},
      serverKeyFor: () => "codespace:octo/repo",
    });
    assert.deepEqual(groups, []);
  });
});
