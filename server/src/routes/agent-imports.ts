import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";
import { WORKSPACE_ID_HEADER } from "../lib/request-workspace.js";
import type { AgentBackendId } from "../lib/agents/types.js";
import {
  findImportedConversation,
  importHarnessSession,
} from "../lib/agents/import/importer.js";
import {
  getImportSourceForBackend,
  IMPORTABLE_BACKEND_IDS,
  listImportSources,
  UNSUPPORTED_IMPORT_BACKENDS,
} from "../lib/agents/import/registry.js";
import { AGENT_BACKENDS } from "../lib/agents/providers.js";

export const agentImportRoutes = new Hono();

function isAgentBackendId(value: string): value is AgentBackendId {
  return value in AGENT_BACKENDS;
}

agentImportRoutes.get("/api/agents/imports/sources", async (c) => {
  const sources = listImportSources();
  const byBackend = new Map(sources.flatMap((source) => source.backendIds.map((id) => [id, source])));

  const results = await Promise.all(
    IMPORTABLE_BACKEND_IDS.map(async (backendId) => {
      const backend = AGENT_BACKENDS[backendId];
      const source = byBackend.get(backendId);
      if (!source) {
        return {
          backendId,
          label: backend?.label ?? backendId,
          harnessKey: null,
          available: false,
          reason: UNSUPPORTED_IMPORT_BACKENDS[backendId] ?? "This harness has no local session storage.",
          sessionCount: 0,
        };
      }
      const detection = await source.detect();
      let sessionCount = 0;
      if (detection.available) {
        try {
          sessionCount = (await source.listSessions()).length;
        } catch (error) {
          return {
            backendId,
            label: backend?.label ?? backendId,
            harnessKey: source.harnessKey,
            available: false,
            reason: `Could not read ${source.displayName} sessions: ${
              error instanceof Error ? error.message : String(error)
            }`,
            storageRoot: detection.storageRoot ?? null,
            sessionCount: 0,
          };
        }
      }
      return {
        backendId,
        label: backend?.label ?? backendId,
        harnessKey: source.harnessKey,
        available: detection.available,
        ...(detection.reason ? { reason: detection.reason } : {}),
        storageRoot: detection.storageRoot ?? null,
        sessionCount,
      };
    })
  );
  return c.json({ sources: results });
});

agentImportRoutes.get("/api/agents/imports/:backendId/sessions", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isAgentBackendId(backendId)) {
    return c.json({ error: `Unknown agent backend: ${backendId}` }, 404);
  }
  const source = getImportSourceForBackend(backendId);
  if (!source) {
    return c.json(
      { error: UNSUPPORTED_IMPORT_BACKENDS[backendId] ?? "Import is not supported for this harness." },
      400
    );
  }
  const sessions = await source.listSessions();

  // Annotate sessions that were already imported into the requesting
  // workspace so the UI opens the existing conversation instead of offering a
  // duplicate import (imports stay in sync with the source automatically).
  const workspaceId = c.req.header(WORKSPACE_ID_HEADER)?.trim();
  const importedByExternalId = new Map<string, string>();
  if (workspaceId) {
    const workspace = await getWorkspaceById(workspaceId);
    if (workspace) {
      for (const session of sessions) {
        const existing = await findImportedConversation(workspace.id, backendId, session.id);
        if (existing) {
          importedByExternalId.set(session.id, existing.id);
        }
      }
    }
  }

  return c.json({
    sessions: sessions.map((session) => ({
      ...session,
      importedConversationId: importedByExternalId.get(session.id) ?? null,
    })),
  });
});

agentImportRoutes.post("/api/agents/imports/:backendId/import", async (c) => {
  const backendId = c.req.param("backendId");
  if (!isAgentBackendId(backendId)) {
    return c.json({ error: `Unknown agent backend: ${backendId}` }, 404);
  }
  const source = getImportSourceForBackend(backendId);
  if (!source) {
    return c.json(
      { error: UNSUPPORTED_IMPORT_BACKENDS[backendId] ?? "Import is not supported for this harness." },
      400
    );
  }
  const workspace = await requireWorkspaceFromRequest(c);
  let sessionId: string | undefined;
  try {
    const body = (await c.req.json()) as { sessionId?: unknown };
    sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  } catch {
    // fall through to error below
  }
  if (!sessionId) {
    return c.json({ error: "Missing sessionId in request body." }, 400);
  }
  try {
    const result = await importHarnessSession({
      workspace,
      backendId,
      externalSessionId: sessionId,
    });
    return c.json(result);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to import session." },
      404
    );
  }
});
