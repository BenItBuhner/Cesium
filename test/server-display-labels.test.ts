import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "../src/lib/agent-types.ts";
import { groupAgentRailGroups } from "../src/lib/agent-rail-groups.ts";
import {
  buildServerDisplayLabels,
  projectListingServerLabel,
  relabelDirectoryWorkspaces,
  relabelRailGroups,
  sameServerDisplayLabels,
  serverDisplayLabel,
  serverSwitchCommands,
} from "../src/lib/server-display-labels.ts";
import { getServerDisplayLabel, renameServerAppearance } from "../src/lib/server-rail-appearance.ts";

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

  test("titles sign-in placeholders with the engine's name and keeps their badge", () => {
    const placeholder: AgentConversationGroup = {
      ...group("localhost:9101", buildBox),
      serverLabel: "Auth required",
      serverAuthRequired: true,
    };
    const [relabeled] = relabelRailGroups([placeholder], labels);
    assert.equal(relabeled?.workspace.name, "Build box");
    assert.equal(relabeled?.serverLabel, "Auth required");
    assert.equal(placeholder.workspace.name, "localhost:9101", "the placeholder itself is not mutated");
    assert.equal(relabelRailGroups([placeholder], labels)[0], relabeled, "and its relabeled copy is reused");
    const unnamed = buildServerDisplayLabels([home, buildBox], {}, {});
    assert.equal(relabelRailGroups([placeholder], unnamed)[0], placeholder, "no name, no change");
  });

  test("leaves servers that are no longer saved alone", () => {
    const groups = [group("old", { id: "gone", label: "old-box:9100" })];
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

describe("the landing pill, server picker, account settings and Settings server list", () => {
  const thisDevice = { id: "local", label: "This device", baseUrl: "http://127.0.0.1:9100" };
  const sidecar = { id: "desktop-sidecar", label: "Sidecar", baseUrl: "http://127.0.0.1:9100" };
  const retired = { id: "old", label: "old-box:9100", baseUrl: "http://old-box:9100" };
  const engineNames = { home: "Home", build: "Build box", local: "laptop", "desktop-sidecar": "laptop" };

  test("call every server what the sidebar calls it", () => {
    const servers = [home, buildBox, thisDevice, sidecar, retired];
    const appearances = { build: { icon: "Globe", color: "#22c55e", nickname: "CI" } };
    const sidebar = buildServerDisplayLabels(servers, appearances, engineNames);
    assert.deepEqual(
      servers.map((server) => serverDisplayLabel(server, appearances, engineNames)),
      ["Home", "CI", "This device", "This device", "old-box:9100"]
    );
    for (const server of servers) {
      assert.equal(serverDisplayLabel(server, appearances, engineNames), sidebar.get(server.id));
    }
  });

  test("a lone server shows its engine's name, and an unnamed engine keeps its connection label", () => {
    assert.equal(serverDisplayLabel(home, {}, { home: "Home" }), "Home");
    assert.equal(serverDisplayLabel(home, {}, {}), "localhost:9100");
    assert.equal(serverDisplayLabel(home, { home: { nickname: "Desk" } }, {}), "Desk");
  });
});

describe("renaming a server in the picker", () => {
  const appearance = { icon: "Server", color: "#22c55e" };

  test("stores the rename as the nickname, so it outranks the engine's name", () => {
    const renamed = renameServerAppearance(appearance, "  Office Mac  ", "Home");
    assert.deepEqual(renamed, { icon: "Server", color: "#22c55e", nickname: "Office Mac" });
    assert.equal(serverDisplayLabel(home, { home: renamed! }, { home: "Home" }), "Office Mac");
  });

  test("changes nothing when the name stays the same", () => {
    assert.equal(renameServerAppearance(appearance, "Home", "Home"), null);
    assert.equal(renameServerAppearance({ ...appearance, nickname: "Desk" }, " Desk ", "Home"), null);
    assert.equal(renameServerAppearance(appearance, "   ", "Home"), null, "no rename to remove");
  });

  test("clearing the name, or typing the engine's name, removes the rename", () => {
    const withRename = { ...appearance, nickname: "Desk" };
    assert.deepEqual(renameServerAppearance(withRename, "", "Home"), appearance);
    assert.deepEqual(renameServerAppearance(withRename, "Home", "Home"), appearance);
    assert.equal(serverDisplayLabel(home, { home: appearance }, { home: "Home" }), "Home");
  });

  test("an unnamed engine's rename wins over its connection label", () => {
    const renamed = renameServerAppearance(appearance, "Staging", "localhost:9100");
    assert.equal(serverDisplayLabel(home, { home: renamed! }, {}), "Staging");
    assert.equal(renameServerAppearance(appearance, "localhost:9100", "localhost:9100"), null);
  });

  test("cuts long names to 80 characters", () => {
    assert.equal(renameServerAppearance(appearance, "x".repeat(120), "Home")?.nickname, "x".repeat(80));
  });
});

describe("the command palette's server entries", () => {
  const staging = { id: "staging", label: "localhost:9114", baseUrl: "http://localhost:9114" };
  const labelFor = (server: { id: string; label: string; baseUrl: string }) =>
    serverDisplayLabel(server, { build: { nickname: "CI" } }, { home: "Home", build: "Build box" });

  test("name each server like the sidebar and mark the active one", () => {
    assert.deepEqual(serverSwitchCommands([home, buildBox, staging], "home", labelFor), [
      {
        serverId: "home",
        label: "Server: Switch to Home (Active)",
        detail: "http://localhost:9100",
        active: true,
        message: "Home is already active",
      },
      {
        serverId: "build",
        label: "Server: Switch to CI",
        detail: "http://localhost:9101",
        active: false,
        message: "Switching to CI",
      },
      {
        serverId: "staging",
        label: "Server: Switch to localhost:9114",
        detail: "http://localhost:9114",
        active: false,
        message: "Switching to localhost:9114",
      },
    ]);
  });
});

describe("a Project listing's server", () => {
  const listed = (engineLabel?: string) => ({ serverId: "home", serverLabel: "localhost:9100", engineLabel });

  test("follows the same order: a rename, then the engine's name, then the connection label", () => {
    assert.equal(projectListingServerLabel(listed("Home"), [home], { home: { nickname: "Desk" } }, { home: "Home" }), "Desk");
    assert.equal(projectListingServerLabel(listed("Home"), [home], {}, { home: "Home" }), "Home");
    assert.equal(projectListingServerLabel(listed(), [home], {}, {}), "localhost:9100");
  });

  test("uses the name the engine listed with until the client has learned it", () => {
    assert.equal(projectListingServerLabel(listed("Home"), [home], {}, {}), "Home");
    assert.equal(projectListingServerLabel(listed("  "), [home], {}, {}), "localhost:9100");
  });

  test("keeps this device, and the listing's names for a server that is no longer saved", () => {
    const sidecar = { id: "desktop-sidecar", label: "Sidecar", baseUrl: "http://127.0.0.1:9100" };
    assert.equal(
      projectListingServerLabel({ serverId: "desktop-sidecar", serverLabel: "Sidecar", engineLabel: "laptop" }, [sidecar], {}, {}),
      "This device"
    );
    assert.equal(
      projectListingServerLabel({ serverId: "gone", serverLabel: "old-box:9100", engineLabel: "Old box" }, [home], {}, {}),
      "Old box"
    );
    assert.equal(projectListingServerLabel({ serverId: "gone", serverLabel: "old-box:9100" }, [home], {}, {}), "old-box:9100");
  });
});
