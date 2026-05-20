import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createServer, type Server } from "node:http";
import {
  fetchWorkspacesForServer,
  listCrossWorkspaceAgentConversationsForServer,
} from "../src/lib/server-api.ts";

type StartedServer = {
  server: Server;
  baseUrl: string;
};

const started: Server[] = [];

function json(res: Parameters<NonNullable<Parameters<typeof createServer>[0]>>[1], body: unknown) {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function startFakeCesiumServer(input: {
  workspaceId: string;
  workspaceName: string;
  conversationId: string;
}): Promise<StartedServer> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      return json(res, { ok: true });
    }
    if (req.url === "/api/workspaces") {
      return json(res, {
        workspaces: [
          {
            id: input.workspaceId,
            name: input.workspaceName,
            root: `/tmp/${input.workspaceName}`,
            createdAt: 1,
            updatedAt: 1,
            lastOpenedAt: 1,
          },
        ],
        defaultWorkspaceId: input.workspaceId,
        lastOpenedWorkspaceId: input.workspaceId,
        recentWorkspaceIds: [input.workspaceId],
        homeWorkspaceId: null,
      });
    }
    if (req.url?.startsWith("/api/agents/conversations/all")) {
      return json(res, {
        backends: [],
        groups: [
          {
            workspace: {
              id: input.workspaceId,
              name: input.workspaceName,
              root: `/tmp/${input.workspaceName}`,
              createdAt: 1,
              updatedAt: 1,
              lastOpenedAt: 1,
            },
            conversations: [
              {
                id: input.conversationId,
                workspaceId: input.workspaceId,
                title: input.conversationId,
                createdAt: 1,
                updatedAt: 2,
                lastEventSeq: 1,
                status: "idle",
                archivedAt: null,
                backendId: "cursor-sdk",
                mode: "agent",
                experimental: false,
                hasPendingPermission: false,
              },
            ],
          },
        ],
        nextCursor: null,
      });
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  started.push(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    started.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("multi-server rail integration", () => {
  test("client APIs can fan out to two independent servers", async () => {
    const serverA = await startFakeCesiumServer({
      workspaceId: "workspace-a",
      workspaceName: "repo-a",
      conversationId: "chat-a",
    });
    const serverB = await startFakeCesiumServer({
      workspaceId: "workspace-b",
      workspaceName: "repo-b",
      conversationId: "chat-b",
    });

    const [workspacesA, workspacesB, railA, railB] = await Promise.all([
      fetchWorkspacesForServer({ serverId: "server-a", baseUrl: serverA.baseUrl }),
      fetchWorkspacesForServer({ serverId: "server-b", baseUrl: serverB.baseUrl }),
      listCrossWorkspaceAgentConversationsForServer({
        serverId: "server-a",
        baseUrl: serverA.baseUrl,
      }),
      listCrossWorkspaceAgentConversationsForServer({
        serverId: "server-b",
        baseUrl: serverB.baseUrl,
      }),
    ]);

    assert.equal(workspacesA.workspaces[0]?.id, "workspace-a");
    assert.equal(workspacesB.workspaces[0]?.id, "workspace-b");
    assert.equal(railA.groups[0]?.conversations[0]?.id, "chat-a");
    assert.equal(railB.groups[0]?.conversations[0]?.id, "chat-b");
  });
});
