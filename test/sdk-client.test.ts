import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CesiumApiError,
  CesiumClient,
  CesiumContractError,
} from "../packages/sdk/src/index.ts";

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe("standalone Cesium SDK", () => {
  test("scopes concurrent workspace requests without mutable global state", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      workspaceId: string | null;
    }> = [];
    const client = new CesiumClient({
      baseUrl: "https://cesium.example/",
      token: async () => "test-token",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("authorization"),
          workspaceId: headers.get("x-opencursor-workspace-id"),
        });
        return json({ matches: [] });
      },
    });

    await Promise.all([
      client.workspace("workspace-a").files.search("alpha"),
      client.workspace("workspace-b").files.search("beta"),
    ]);

    assert.deepEqual(
      requests.map((request) => request.workspaceId).sort(),
      ["workspace-a", "workspace-b"]
    );
    assert.ok(requests.every((request) => request.authorization === "Bearer test-token"));
    assert.ok(requests.some((request) => request.url.endsWith("/api/fs/search?q=alpha")));
    assert.ok(requests.some((request) => request.url.endsWith("/api/fs/search?q=beta")));
  });

  test("validates stable server metadata at runtime", async () => {
    const client = new CesiumClient({
      baseUrl: "https://cesium.example",
      fetch: async () =>
        json({
          name: "cesium",
          protocolVersion: "1.0.0",
          capabilities: ["workspaces", "agents.conversations"],
          transports: { http: "/api", websocket: "/ws" },
        }),
    });

    const metadata = await client.system.assertCompatible();
    assert.equal(metadata.protocolVersion, "1.0.0");
    assert.deepEqual(metadata.capabilities, [
      "workspaces",
      "agents.conversations",
    ]);
  });

  test("surfaces invalid contracts separately from API failures", async () => {
    const invalidClient = new CesiumClient({
      baseUrl: "https://cesium.example",
      fetch: async () => json({ name: "not-cesium" }),
    });
    await assert.rejects(
      invalidClient.system.meta(),
      (error: unknown) => error instanceof CesiumContractError
    );

    const failedClient = new CesiumClient({
      baseUrl: "https://cesium.example",
      fetch: async () =>
        json(
          {
            error: {
              code: "workspace_missing",
              message: "Unknown workspace.",
              details: { workspaceId: "missing" },
            },
            requestId: "request-123",
          },
          { status: 404 }
        ),
    });
    await assert.rejects(
      failedClient.workspaces.list(),
      (error: unknown) =>
        error instanceof CesiumApiError &&
        error.status === 404 &&
        error.code === "workspace_missing" &&
        error.requestId === "request-123"
    );
  });

  test("preserves ETag concurrency explicitly", async () => {
    const requests: RequestInit[] = [];
    const client = new CesiumClient({
      baseUrl: "https://cesium.example",
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        if ((init?.method ?? "GET") === "GET") {
          return json(
            { settings: { schemaVersion: 1 }, revision: 7 },
            { headers: { etag: "\"7\"" } }
          );
        }
        return json(
          { ok: true, revision: 8 },
          { headers: { etag: "\"8\"" } }
        );
      },
    });

    const current = await client.settings.getGlobal<{ schemaVersion: 1 }>();
    const updated = await client.settings.updateGlobal(current.settings, {
      etag: current.etag ?? undefined,
    });

    assert.equal(current.etag, "\"7\"");
    assert.equal(updated.etag, "\"8\"");
    assert.equal(new Headers(requests[1]?.headers).get("if-match"), "\"7\"");
  });

  test("unwraps workspace resource response envelopes", async () => {
    const board = {
      schemaVersion: 1,
      id: "board-1",
      workspaceId: "workspace-1",
      title: "SDK board",
      description: "",
      headConversationId: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      settings: {
        allowedBackendIds: [],
        defaultChildBackendId: null,
        defaultModelByBackend: {},
        maxConcurrentIssues: null,
        maxConcurrentAgents: null,
        userQuestionTimeoutMs: 60_000,
        mcpEnabled: true,
      },
    };
    const snapshot = { board, issues: [], assignments: [], events: [] };
    const client = new CesiumClient({
      baseUrl: "https://cesium.example",
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/git/status")) {
          return json({
            workspace: { id: "workspace-1" },
            status: {
              isGitRepo: true,
              root: "/workspace",
              branches: [],
              worktrees: [],
            },
          });
        }
        return json({ snapshot });
      },
    });
    const workspace = client.workspace("workspace-1");

    const status = await workspace.git.status();
    const created = await workspace.orchestration.createBoard({
      title: "SDK board",
    });

    assert.equal(status.isGitRepo, true);
    assert.equal(created.board.id, "board-1");
  });
});
