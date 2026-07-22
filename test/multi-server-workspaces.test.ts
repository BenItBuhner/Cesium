import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentConversationGroup } from "../src/lib/agent-types.ts";
import type { DirectoryWorkspaceRecord } from "../src/contexts/WorkspaceDirectoryContext.tsx";
import {
  filterGroupsByMachine,
  getRepositoryGroupingKey,
  groupDirectoryWorkspacesByRepository,
  sortDirectoryWorkspaces,
} from "../src/lib/multi-server-workspaces.ts";

function workspace(input: {
  id: string;
  serverId: string;
  serverLabel: string;
  name?: string;
  repositoryId?: string;
  lastOpenedAt?: number;
}): DirectoryWorkspaceRecord {
  return {
    id: input.id,
    name: input.name ?? input.id,
    root: `/machines/${input.serverId}/${input.id}`,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: input.lastOpenedAt ?? 1,
    serverId: input.serverId,
    serverLabel: input.serverLabel,
    serverBaseUrl: `https://${input.serverId}.example.test`,
    workspaceKey: `${input.serverId}:${input.id}`,
    repository: input.repositoryId
      ? {
          isGitRepo: true,
          repoRoot: `/machines/${input.serverId}/cesium`,
          repositoryId: input.repositoryId,
        }
      : undefined,
  };
}

describe("multi-server workspace organization", () => {
  test("uses network identity across machines and scopes local-only repositories", () => {
    assert.equal(
      getRepositoryGroupingKey({
        repository: { isGitRepo: true, repositoryId: "github.com/acme/cesium" },
        serverId: "laptop",
        fallbackRoot: "/src/cesium",
      }),
      "remote:github.com/acme/cesium"
    );
    assert.notEqual(
      getRepositoryGroupingKey({
        repository: { isGitRepo: true, repoKey: "/git/cesium" },
        serverId: "laptop",
        fallbackRoot: "/src/cesium",
      }),
      getRepositoryGroupingKey({
        repository: { isGitRepo: true, repoKey: "/git/cesium" },
        serverId: "desktop",
        fallbackRoot: "/src/cesium",
      })
    );
  });

  test("groups clones of one repository into machine-specific rows", () => {
    const sections = groupDirectoryWorkspacesByRepository([
      workspace({
        id: "home",
        serverId: "laptop",
        serverLabel: "Laptop",
        repositoryId: "github.com/acme/cesium",
      }),
      workspace({
        id: "work",
        serverId: "desktop",
        serverLabel: "Desktop",
        repositoryId: "github.com/acme/cesium",
      }),
      workspace({ id: "notes", serverId: "laptop", serverLabel: "Laptop" }),
    ]);
    assert.equal(sections.length, 2);
    assert.equal(sections[0]?.label, "cesium");
    assert.equal(sections[0]?.machineCount, 2);
    assert.deepEqual(
      sections[0]?.items.map((item) => item.workspaceKey),
      ["laptop:home", "desktop:work"]
    );
  });

  test("filters hidden machines without hiding newly connected machines", () => {
    const groups = [
      {
        workspace: workspace({
          id: "one",
          serverId: "laptop",
          serverLabel: "Laptop",
        }),
        serverId: "laptop",
        conversations: [],
      },
      {
        workspace: workspace({
          id: "two",
          serverId: "desktop",
          serverLabel: "Desktop",
        }),
        serverId: "desktop",
        conversations: [],
      },
      {
        workspace: workspace({
          id: "three",
          serverId: "new-machine",
          serverLabel: "New machine",
        }),
        serverId: "new-machine",
        conversations: [],
      },
    ] satisfies AgentConversationGroup[];
    assert.deepEqual(
      filterGroupsByMachine(groups, ["desktop"]).map((group) => group.serverId),
      ["laptop", "new-machine"]
    );
  });

  test("sorts deterministically by machine then workspace", () => {
    const sorted = sortDirectoryWorkspaces(
      [
        workspace({ id: "zeta", serverId: "laptop", serverLabel: "Laptop" }),
        workspace({ id: "beta", serverId: "desktop", serverLabel: "Desktop" }),
        workspace({ id: "alpha", serverId: "desktop", serverLabel: "Desktop" }),
      ],
      "machine"
    );
    assert.deepEqual(
      sorted.map((item) => item.workspaceKey),
      ["desktop:alpha", "desktop:beta", "laptop:zeta"]
    );
  });
});
