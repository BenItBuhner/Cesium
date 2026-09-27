import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "../src/lib/agent-types.ts";
import { groupAgentRailGroups } from "../src/lib/agent-rail-groups.ts";
import {
  buildServerDisplayLabels,
  relabelDirectoryWorkspaces,
  relabelRailGroups,
  sameServerDisplayLabels,
} from "../src/lib/server-display-labels.ts";
import { getServerDisplayLabel } from "../src/lib/server-rail-appearance.ts";

const home = { id: "home", label: "localhost:9100", baseUrl: "http://localhost:9100" };
const buildBox = { id: "build", label: "localhost:9101", baseUrl: "http://localhost:9101" };

function conversation(
  id: string,
  serverId: string,
  serverLabel: string
): AgentRailConversationSummary {
  return {
    id,
    workspaceId: "ws",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    archivedAt: null,
    backendId: "cesium-agent",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    serverId,
    serverLabel,
    workspaceKey: `${serverId}:ws`,
    conversationKey: `${serverId}:${id}`,
  } as AgentRailConversationSummary;
}

function group(
  name: string,
  server: { id: string; label: string },
  conversations: AgentRailConversationSummary[] = []
): AgentConversationGroup {
  return {
    workspace: {
      id: name,
      name,
      root: `/work/${name}`,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversations,
    serverId: server.id,
    serverLabel: server.label,
    workspaceKey: `${server.id}:${name}`,
  };
}

describe("server display labels", () => {
  test("prefer the engine's name over the connection label", () => {
    assert.equal(getServerDisplayLabel(home, undefined, "Home"), "Home");
    assert.equal(getServerDisplayLabel(home, undefined, "  Home  "), "Home");
  });

  test("fall back to the connection label when the engine has no name", () => {
    assert.equal(getServerDisplayLabel(home), "localhost:9100");
    assert.equal(getServerDisplayLabel(home, undefined, null), "localhost:9100");
    assert.equal(getServerDisplayLabel(home, undefined, "   "), "localhost:9100");
  });

  test("a rename the user gave the server still wins", () => {
    assert.equal(getServerDisplayLabel(home, { nickname: "Desk" }, "Home"), "Desk");
    assert.equal(getServerDisplayLabel(home, { nickname: "  " }, "Home"), "Home");
  });

  test("this device stays this device", () => {
    const sidecar = { id: "desktop-sidecar", label: "Sidecar", baseUrl: "http://127.0.0.1:9100" };
    assert.equal(getServerDisplayLabel(sidecar, { nickname: "Desk" }, "laptop"), "This device");
  });

  test("labels every saved server, including a lone one", () => {
    assert.deepEqual(
      [...buildServerDisplayLabels([home], {}, { home: "Home" })],
      [["home", "Home"]]
    );
    assert.deepEqual(
      [...buildServerDisplayLabels([home, buildBox], { build: { icon: "Globe", nickname: "CI" } }, {})],
      [
        ["home", "localhost:9100"],
        ["build", "CI"],
      ]
    );
  });

  test("compares label maps by content", () => {
    const a = buildServerDisplayLabels([home], {}, { home: "Home" });
    assert.equal(sameServerDisplayLabels(a, buildServerDisplayLabels([home], {}, { home: "Home" })), true);
    assert.equal(sameServerDisplayLabels(a, buildServerDisplayLabels([home], {}, {})), false);
    assert.equal(sameServerDisplayLabels(a, new Map()), false);
  });
});

describe("relabeling the sidebar", () => {
  const labels = buildServerDisplayLabels([home, buildBox], {}, { home: "Home", build: "Build box" });

  test("workspace groups and their conversations show the engine's name", () => {
    const groups = [
      group("storefront", home, [conversation("c1", "home", home.label)]),
      group("docs-site", buildBox, [conversation("c2", "build", buildBox.label)]),
    ];
    const relabeled = relabelRailGroups(groups, labels);
    assert.deepEqual(
      relabeled.map((entry) => [entry.serverLabel, entry.conversations[0]?.serverLabel]),
      [
        ["Home", "Home"],
        ["Build box", "Build box"],
      ]
    );
    assert.equal(groups[0]?.serverLabel, home.label, "the fetched groups are not mutated");
  });

  test("grouping by machine names each machine after its engine", () => {
    const relabeled = relabelRailGroups(
      [
        group("storefront", home, [conversation("c1", "home", home.label)]),
        group("payments-api", home, [conversation("c2", "home", home.label)]),
        group("docs-site", buildBox, [conversation("c3", "build", buildBox.label)]),
      ],
      labels
    );
    assert.deepEqual(
      groupAgentRailGroups(relabeled, "server").map((entry) => entry.workspace.name).sort(),
      ["Build box", "Home"]
    );
  });

  test("keeps labels when engines report no names", () => {
    const groups = [group("storefront", home, [conversation("c1", "home", home.label)])];
    assert.equal(relabelRailGroups(groups, buildServerDisplayLabels([home], {}, {})), groups);
    assert.equal(relabelRailGroups(groups, new Map()), groups);
  });

  test("leaves sign-in placeholders and servers that are no longer saved alone", () => {
    const placeholder: AgentConversationGroup = {
      ...group("localhost:9101", buildBox),
      serverLabel: "Auth required",
      serverAuthRequired: true,
    };
    const removed = group("old", { id: "gone", label: "old-box:9100" });
    const groups = [placeholder, removed];
    assert.equal(relabelRailGroups(groups, labels), groups);
  });

  test("reuses relabeled objects while their source and label are unchanged", () => {
    const storefront = group("storefront", home, [conversation("c1", "home", home.label)]);
    const docs = group("docs-site", buildBox, [conversation("c2", "build", buildBox.label)]);
    const first = relabelRailGroups([storefront, docs], labels);
    const patchedDocs = { ...docs, conversations: [...docs.conversations, conversation("c3", "build", buildBox.label)] };
    const second = relabelRailGroups([storefront, patchedDocs], labels);
    assert.equal(second[0], first[0], "an untouched group keeps its relabeled identity");
    assert.notEqual(second[1], first[1]);
    assert.equal(
      second[1]?.conversations[0],
      first[1]?.conversations[0],
      "an untouched conversation keeps its relabeled identity"
    );

    const renamed = buildServerDisplayLabels([home, buildBox], {}, { home: "Home office", build: "Build box" });
    const third = relabelRailGroups([storefront, patchedDocs], renamed);
    assert.equal(third[0]?.serverLabel, "Home office");
    assert.equal(third[0]?.conversations[0]?.serverLabel, "Home office");
  });

  test("workspace picker records show the engine's name", () => {
    const records = [
      { id: "storefront", serverId: "home", serverLabel: home.label },
      { id: "docs-site", serverId: "build", serverLabel: buildBox.label },
      { id: "old", serverId: "gone", serverLabel: "old-box:9100" },
    ];
    const relabeled = relabelDirectoryWorkspaces(records, labels);
    assert.deepEqual(
      relabeled.map((record) => record.serverLabel),
      ["Home", "Build box", "old-box:9100"]
    );
    assert.equal(relabeled[2], records[2]);
    assert.equal(relabelDirectoryWorkspaces(records, labels)[0], relabeled[0]);
    assert.equal(relabelDirectoryWorkspaces(records, new Map()), records);
  });
});
