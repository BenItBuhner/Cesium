import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentConversationGroup, AgentRailConversationSummary } from "../src/lib/agent-types.ts";
import { groupAgentRailGroups } from "../src/lib/agent-rail-groups.ts";
import type { WorkspaceRecord } from "../src/lib/types.ts";

function workspace(id: string, name = id): WorkspaceRecord {
  return {
    id,
    name,
    root: `/tmp/${name}`,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
}

function conversation(
  id: string,
  workspaceId: string,
  updatedAt: number,
  overrides: Partial<AgentRailConversationSummary> = {}
): AgentRailConversationSummary {
  return {
    id,
    workspaceId,
    title: id,
    createdAt: updatedAt - 1,
    updatedAt,
    lastEventSeq: 1,
    status: "idle",
    archivedAt: null,
    backendId: "cursor-sdk",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    ...overrides,
  };
}

describe("agent rail grouping", () => {
  test("groups conversations by repository key across workspaces", () => {
    const groups: AgentConversationGroup[] = [
      {
        workspace: workspace("main", "repo"),
        repositoryKey: "server-a:repo",
        repository: { isGitRepo: true, repoRoot: "/tmp/repo", currentBranch: "main" },
        conversations: [
          conversation("main-chat", "main", 10, {
            repositoryKey: "server-a:repo",
          }),
        ],
      },
      {
        workspace: workspace("branch", "repo-branch"),
        repositoryKey: "server-a:repo",
        repository: { isGitRepo: true, repoRoot: "/tmp/repo", currentBranch: "feature" },
        conversations: [
          conversation("branch-chat", "branch", 20, {
            repositoryKey: "server-a:repo",
          }),
        ],
      },
    ];

    const grouped = groupAgentRailGroups(groups, "repository");
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]?.workspace.name, "repo");
    assert.deepEqual(grouped[0]?.conversations.map((item) => item.id), [
      "branch-chat",
      "main-chat",
    ]);
  });

  test("groups the same remote repository across machines while retaining conversation owners", () => {
    const repositoryKey = "remote:github.com/acme/cesium";
    const grouped = groupAgentRailGroups(
      [
        {
          workspace: workspace("laptop-workspace", "cesium"),
          serverId: "laptop",
          serverLabel: "Laptop",
          repositoryKey,
          conversations: [
            conversation("laptop-chat", "laptop-workspace", 10, {
              serverId: "laptop",
              serverLabel: "Laptop",
              conversationKey: "laptop:laptop-chat",
              repositoryKey,
            }),
          ],
        },
        {
          workspace: workspace("desktop-workspace", "cesium"),
          serverId: "desktop",
          serverLabel: "Desktop",
          repositoryKey,
          conversations: [
            conversation("desktop-chat", "desktop-workspace", 20, {
              serverId: "desktop",
              serverLabel: "Desktop",
              conversationKey: "desktop:desktop-chat",
              repositoryKey,
            }),
          ],
        },
      ],
      "repository"
    );
    assert.equal(grouped.length, 1);
    assert.deepEqual(
      grouped[0]?.conversations.map((item) => [item.id, item.serverId]),
      [
        ["desktop-chat", "desktop"],
        ["laptop-chat", "laptop"],
      ]
    );
  });

  test("groups conversations by server environment", () => {
    const grouped = groupAgentRailGroups(
      [
        {
          workspace: workspace("a"),
          serverId: "server-a",
          serverLabel: "Home Mac",
          conversations: [conversation("a-chat", "a", 1)],
        },
        {
          workspace: workspace("b"),
          serverId: "server-b",
          serverLabel: "Work PC",
          conversations: [conversation("b-chat", "b", 1)],
        },
      ],
      "server"
    );
    assert.deepEqual(grouped.map((group) => group.workspace.name), ["Home Mac", "Work PC"]);
  });

  test("workspace mode keeps identically-named workspaces from different servers separate", () => {
    const grouped = groupAgentRailGroups(
      [
        {
          workspace: workspace("ws-1", "Home"),
          serverId: "server-a",
          serverLabel: "Local",
          workspaceKey: "server-a:ws-1",
          conversations: [conversation("local-chat", "ws-1", 1)],
        },
        {
          workspace: workspace("ws-1", "Home"),
          serverId: "server-b",
          serverLabel: "Prod",
          workspaceKey: "server-b:ws-1",
          conversations: [conversation("prod-chat", "ws-1", 2)],
        },
      ],
      "workspace"
    );
    assert.equal(grouped.length, 2);
    assert.deepEqual(
      grouped
        .map((group) =>
          group.conversations.map((conversation) => conversation.id).sort()
        )
        .sort(),
      [["local-chat"], ["prod-chat"]]
    );
  });

  test("status grouping never merges conversations across servers", () => {
    const grouped = groupAgentRailGroups(
      [
        {
          workspace: workspace("ws-1", "Home"),
          serverId: "server-a",
          serverLabel: "Local",
          conversations: [conversation("local-idle", "ws-1", 1, { status: "idle" })],
        },
        {
          workspace: workspace("ws-1", "Home"),
          serverId: "server-b",
          serverLabel: "Prod",
          conversations: [conversation("prod-idle", "ws-1", 2, { status: "idle" })],
        },
      ],
      "status"
    );
    assert.equal(grouped.length, 2);
    const totalConversations = grouped.reduce(
      (sum, group) => sum + group.conversations.length,
      0
    );
    assert.equal(totalConversations, 2);
  });
});
