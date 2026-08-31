/**
 * `/api/terminals` CRUD backed by the shell session hub.
 */
import { errorResponse, jsonResponse, type EngineRouter } from "../http";
import type { TerminalChannelHub } from "../channels/terminal-channel";
import type { WorkspaceStore } from "../stores/workspaces";

export function registerTerminalRoutes(
  router: EngineRouter,
  terminals: TerminalChannelHub,
  workspaces: WorkspaceStore
): void {
  router.get("/api/terminals", async (request) => {
    const list = terminals.list(request.workspaceId);
    return jsonResponse({
      terminals: list.map((terminal) => ({
        id: terminal.id,
        shell: "cesium-sh (browser)",
        cwd: terminal.cwd,
        alive: terminal.alive,
        attachedClients: terminal.attachedClients,
      })),
    });
  });

  router.post("/api/terminals", async (request) => {
    if (!request.workspaceId) {
      return errorResponse("Missing x-opencursor-workspace-id header");
    }
    const workspace = await workspaces.getById(request.workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${request.workspaceId}`, 404);
    }
    const record = await terminals.create(workspace.id);
    return jsonResponse(
      {
        terminal: {
          id: record.id,
          shell: "cesium-sh (browser)",
          cwd: record.cwd,
          alive: true,
          attachedClients: 0,
        },
      },
      201
    );
  });

  router.delete("/api/terminals/:terminalId", async (request) => {
    const terminalId = request.params.terminalId ?? "";
    if (!terminals.kill(terminalId)) {
      return errorResponse(`Unknown terminal: ${terminalId}`, 404);
    }
    return jsonResponse({ ok: true });
  });
}
