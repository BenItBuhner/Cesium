import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { getWorkspaceById, listWorkspaces, type WorkspaceRecord } from "../lib/workspace-registry.js";
import { getStorage } from "../storage/runtime.js";
import {
  getOpenVsxDetail,
  installOpenVsxExtension,
  searchOpenVsx,
} from "../lib/extensions/install-store.js";
import { classifyExtensionManifest } from "../lib/extensions/manifest-classifier.js";
import {
  activateExtension,
  executeExtensionCommand,
  getExtensionHostStatus,
  releaseExtensionHost,
  retainExtensionHost,
  stopExtensionHost,
} from "../lib/extensions/host-runtime.js";
import {
  attachExtensionSurfaceSession,
  closeExtensionSurfaceSession,
  closeExtensionSurfaceSessionsForExtension,
  closeWorkspaceExtensionSurfaceSessions,
  deliverExtensionSurfaceSessionMessage,
  detachExtensionSurfaceSession,
  ensureExtensionSurfaceSession,
  findExtensionSurfaceDescriptorBySessionId,
  getExtensionSurfaceSession,
  listExtensionSurfaceSessions,
  readExtensionSurfaceEvents,
  updateExtensionSurfaceState,
  updateExtensionSurfaceTheme,
  type ExtensionSurfaceKind,
  type ExtensionSurfacePlacement,
  type ExtensionWebviewThemeSnapshot,
} from "../lib/extensions/surface-sessions.js";
import {
  EXTENSION_COMPATIBILITY_MATRIX,
} from "../lib/extensions/compatibility-matrix.js";
import { EXTENSION_API_CAPABILITIES } from "../lib/extensions/vscode-api-capabilities.js";
import type {
  ExtensionInstallRecord,
  ExtensionPermissionKind,
} from "../lib/extensions/types.js";

export const extensionRoutes = new Hono();

function normalizeExtensionId(value: string): string {
  return value.trim().toLowerCase();
}

function publicRecord(record: ExtensionInstallRecord): ExtensionInstallRecord {
  return record;
}

function workspaceRootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cloneExtensionRecordForWorkspace(
  record: ExtensionInstallRecord,
  workspaceId: string
): ExtensionInstallRecord {
  return {
    ...record,
    workspaceId,
    permissions: record.permissions.map((grant) => ({
      ...grant,
      workspaceId,
    })),
    runtime: {
      ...record.runtime,
      hostRunning: false,
      activated: false,
    },
    updatedAt: Date.now(),
  };
}

function withHydratedCapabilities(record: ExtensionInstallRecord): ExtensionInstallRecord {
  if (record.manifest.capabilities) {
    return record;
  }
  return {
    ...record,
    manifest: {
      ...record.manifest,
      capabilities: classifyExtensionManifest(record.manifest.raw),
    },
  };
}

async function ensureInstalledExtensionsForWorkspace(
  workspace: WorkspaceRecord
): Promise<ExtensionInstallRecord[]> {
  const storage = await getStorage();
  const rawCurrent = await storage.listInstalledExtensions(workspace.id);
  const current = rawCurrent.map(withHydratedCapabilities);
  const byExtensionId = new Map(current.map((record) => [record.extensionId, record]));
  const rootKey = workspaceRootKey(workspace.root);
  const otherWorkspaces = (await listWorkspaces()).filter(
    (candidate) => candidate.id !== workspace.id
  );
  const siblingWorkspaces = otherWorkspaces.filter(
    (candidate) =>
      workspaceRootKey(candidate.root) === rootKey
  );

  // VS Code extensions are user-level installs. Older beta builds stored records
  // under the active workspace id, so a browser that opens a different workspace
  // id looked "stock". Prefer same-root migrations, then fill gaps from any
  // existing extension-bearing workspace.
  const sourceWorkspaces = [
    ...siblingWorkspaces,
    ...otherWorkspaces.filter(
      (candidate) => !siblingWorkspaces.some((sibling) => sibling.id === candidate.id)
    ),
  ];

  for (const sourceWorkspace of sourceWorkspaces) {
    const sourceRecords = (await storage.listInstalledExtensions(sourceWorkspace.id)).map(withHydratedCapabilities);
    for (const record of sourceRecords) {
      if (byExtensionId.has(record.extensionId)) continue;
      const cloned = cloneExtensionRecordForWorkspace(record, workspace.id);
      await storage.upsertInstalledExtension(cloned);
      byExtensionId.set(cloned.extensionId, cloned);
    }
  }

  await Promise.all(
    current
      .filter((record, index) => !rawCurrent[index]?.manifest.capabilities)
      .map((record) => storage.upsertInstalledExtension(record))
  );

  return [...byExtensionId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

async function getInstalledExtensionForWorkspace(
  workspace: WorkspaceRecord,
  extensionId: string
): Promise<ExtensionInstallRecord | null> {
  const storage = await getStorage();
  const direct = await storage.getInstalledExtension(workspace.id, extensionId);
  if (direct) return direct;
  const records = await ensureInstalledExtensionsForWorkspace(workspace);
  return records.find((record) => record.extensionId === extensionId) ?? null;
}

function extensionResourceMime(resourcePath: string): string {
  const ext = path.extname(resourcePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".ttf") return "font/ttf";
  return "application/octet-stream";
}

function asSurfaceKind(value: unknown): ExtensionSurfaceKind {
  return value === "marketplace" ||
    value === "webview" ||
    value === "customEditor" ||
    value === "output"
    ? value
    : "view";
}

function asSurfacePlacement(value: unknown): ExtensionSurfacePlacement | undefined {
  return value === "sidebar" || value === "editor" ? value : undefined;
}

function asThemeSnapshot(value: unknown): ExtensionWebviewThemeSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as { colorScheme?: unknown; variables?: unknown };
  if (raw.colorScheme !== "dark" && raw.colorScheme !== "light") {
    return undefined;
  }
  if (!raw.variables || typeof raw.variables !== "object" || Array.isArray(raw.variables)) {
    return undefined;
  }
  const variables: Record<string, string> = {};
  for (const [key, color] of Object.entries(raw.variables)) {
    if (typeof color === "string") {
      variables[key] = color;
    }
  }
  return { colorScheme: raw.colorScheme, variables };
}

extensionRoutes.get("/api/extensions/beta/status", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  return c.json({
    enabled: true,
    host: getExtensionHostStatus(workspace.id),
    compatibilityMatrix: EXTENSION_COMPATIBILITY_MATRIX,
    apiCapabilities: EXTENSION_API_CAPABILITIES,
  });
});

extensionRoutes.get("/api/extensions/marketplace/search", async (c) => {
  const query = c.req.query("query") ?? c.req.query("q") ?? "*";
  const size = Number.parseInt(c.req.query("size") ?? "20", 10);
  const result = await searchOpenVsx({
    query,
    size: Number.isFinite(size) ? size : 20,
    category: c.req.query("category") ?? undefined,
    sortBy: c.req.query("sortBy") ?? "downloadCount",
    sortOrder: c.req.query("sortOrder") ?? "desc",
    namespace: c.req.query("namespace") ?? undefined,
  });
  c.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
  return c.json(result);
});

extensionRoutes.get("/api/extensions/marketplace/:namespace/:name", async (c) => {
  const detail = await getOpenVsxDetail({
    namespace: c.req.param("namespace"),
    name: c.req.param("name"),
    version: c.req.query("version") ?? undefined,
  });
  c.header("Cache-Control", "private, max-age=120, stale-while-revalidate=600");
  return c.json({ extension: detail });
});

extensionRoutes.get("/api/workspaces/:workspaceId/extensions", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const extensions = await ensureInstalledExtensionsForWorkspace(workspace);
  return c.json({
    extensions: extensions.map(publicRecord),
    host: getExtensionHostStatus(workspace.id),
  });
});

extensionRoutes.get("/api/workspaces/:workspaceId/extensions/surfaces", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  await ensureInstalledExtensionsForWorkspace(workspace);
  return c.json({
    sessions: listExtensionSurfaceSessions(workspace.id),
    host: getExtensionHostStatus(workspace.id),
  });
});

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/:extensionId/surfaces/:surfaceId/sessions",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    await ensureInstalledExtensionsForWorkspace(workspace);
    const body: {
      title?: string;
      kind?: unknown;
      viewType?: string;
      placement?: unknown;
      sessionId?: string;
      theme?: unknown;
      includeMessages?: boolean;
    } = await c.req.json().catch(() => ({}));
    const snapshot = await ensureExtensionSurfaceSession({
      workspace,
      extensionId: normalizeExtensionId(c.req.param("extensionId")),
      surfaceId: c.req.param("surfaceId"),
      title: body.title,
      kind: asSurfaceKind(body.kind),
      viewType: body.viewType,
      placement: asSurfacePlacement(body.placement),
      sessionId: body.sessionId,
      theme: asThemeSnapshot(body.theme),
    });
    return c.json(body.includeMessages === false ? { ...snapshot, messages: [] } : snapshot);
  }
);

extensionRoutes.get(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/snapshot",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const session = listExtensionSurfaceSessions(workspace.id).find(
      (candidate) => candidate.sessionId === c.req.param("sessionId")
    );
    if (!session) {
      const extensions = await ensureInstalledExtensionsForWorkspace(workspace);
      const descriptor = findExtensionSurfaceDescriptorBySessionId({
        workspaceId: workspace.id,
        extensions,
        sessionId: c.req.param("sessionId"),
      });
      if (!descriptor) {
        return c.json({ error: "Unknown extension surface session." }, 404);
      }
      const snapshot = await ensureExtensionSurfaceSession({
        workspace,
        extensionId: descriptor.extensionId,
        surfaceId: descriptor.surfaceId,
        title: descriptor.title,
        kind: descriptor.kind,
        viewType: descriptor.viewType,
        placement: descriptor.placement,
        sessionId: c.req.param("sessionId"),
      });
      return c.json(snapshot);
    }
    const snapshot = await ensureExtensionSurfaceSession({
      workspace,
      extensionId: session.extensionId,
      surfaceId: session.surfaceId,
      title: session.title,
      kind: session.kind,
      viewType: session.viewType,
      sessionId: session.sessionId,
      theme: session.theme,
    });
    return c.json(snapshot);
  }
);

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/attach",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body: { clientId?: string; theme?: unknown } = await c.req.json().catch(() => ({}));
    const snapshot = await attachExtensionSurfaceSession({
      workspace,
      sessionId: c.req.param("sessionId"),
      clientId: body.clientId,
      theme: asThemeSnapshot(body.theme),
    });
    return c.json(snapshot);
  }
);

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/detach",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body: { clientId?: string } = await c.req.json().catch(() => ({}));
    return c.json({
      session: await detachExtensionSurfaceSession({
        workspaceId: workspace.id,
        sessionId: c.req.param("sessionId"),
        clientId: body.clientId,
      }),
    });
  }
);

extensionRoutes.delete(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    return c.json({
      ok: await closeExtensionSurfaceSession({
        workspaceId: workspace.id,
        sessionId: c.req.param("sessionId"),
      }),
      host: getExtensionHostStatus(workspace.id),
    });
  }
);

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/message",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body: { message?: unknown } = await c.req.json().catch(() => ({}));
    if (!getExtensionSurfaceSession(workspace.id, c.req.param("sessionId"))) {
      return c.json({
        session: null,
        html: "",
        htmlVersion: 0,
        messages: [],
        externalUrls: [],
        host: getExtensionHostStatus(workspace.id),
        missingWebview: true,
      });
    }
    return c.json(
      await deliverExtensionSurfaceSessionMessage({
        workspace,
        sessionId: c.req.param("sessionId"),
        message: body.message,
      })
    );
  }
);

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/state",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body: { state?: unknown } = await c.req.json().catch(() => ({}));
    return c.json(
      await updateExtensionSurfaceState({
        workspaceId: workspace.id,
        sessionId: c.req.param("sessionId"),
        state: body.state,
      })
    );
  }
);

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/theme",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body: { theme?: unknown } = await c.req.json().catch(() => ({}));
    const theme = asThemeSnapshot(body.theme);
    if (!theme) {
      return c.json({ error: "Expected theme snapshot." }, 400);
    }
    return c.json(
      await updateExtensionSurfaceTheme({
        workspace,
        sessionId: c.req.param("sessionId"),
        theme,
      })
    );
  }
);

extensionRoutes.get(
  "/api/workspaces/:workspaceId/extensions/surface-sessions/:sessionId/events",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const cursor = Number.parseInt(c.req.query("cursor") ?? "0", 10);
    return c.json(
      readExtensionSurfaceEvents({
        workspaceId: workspace.id,
        sessionId: c.req.param("sessionId"),
        cursor: Number.isFinite(cursor) ? cursor : 0,
      })
    );
  }
);

extensionRoutes.get("/api/workspaces/:workspaceId/extensions/:extensionId/resource", async (c) => {
  const workspace = await getWorkspaceById(c.req.param("workspaceId"));
  if (!workspace) {
    return c.json({ error: "Unknown workspace." }, 404);
  }
  const resourcePath = c.req.query("path");
  if (!resourcePath?.trim()) {
    return c.json({ error: "Missing resource path." }, 400);
  }
  const record = await getInstalledExtensionForWorkspace(
    workspace,
    normalizeExtensionId(c.req.param("extensionId"))
  );
  if (!record) {
    return c.json({ error: "Extension not found." }, 404);
  }
  const extensionRoot = path.resolve(record.installPath, "extension");
  const absolutePath = path.resolve(extensionRoot, resourcePath.replace(/^[/\\]+/, ""));
  if (absolutePath !== extensionRoot && !absolutePath.startsWith(`${extensionRoot}${path.sep}`)) {
    return c.json({ error: "Resource path escapes extension root." }, 400);
  }
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return c.json({ error: "Resource not found." }, 404);
  }
  const etag = `"${createHash("sha1")
    .update(`${absolutePath}\0${stat.size}\0${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 16)}"`;
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304, {
      "Cache-Control": "private, max-age=31536000, immutable",
      "ETag": etag,
    });
  }
  const bytes = await fs.readFile(absolutePath).catch(() => null);
  if (!bytes) {
    return c.json({ error: "Resource not found." }, 404);
  }
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  c.header("ETag", etag);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
  return c.body(bytes, 200, { "Content-Type": extensionResourceMime(absolutePath) });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/install", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{
    source?: "open-vsx";
    namespace?: string;
    name?: string;
    version?: string;
  }>();
  if (body.source !== "open-vsx" || !body.namespace?.trim() || !body.name?.trim()) {
    return c.json({ error: "Expected Open VSX namespace and name." }, 400);
  }
  const record = await installOpenVsxExtension({
    workspaceId: workspace.id,
    namespace: body.namespace.trim(),
    name: body.name.trim(),
    version: body.version?.trim() || undefined,
  });
  return c.json({ extension: publicRecord(record), host: getExtensionHostStatus(workspace.id) });
});

extensionRoutes.patch("/api/workspaces/:workspaceId/extensions/:extensionId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const extensionId = normalizeExtensionId(c.req.param("extensionId"));
  const body = await c.req.json<{ enabled?: boolean }>();
  const storage = await getStorage();
  const record = await getInstalledExtensionForWorkspace(workspace, extensionId);
  if (!record) {
    return c.json({ error: "Extension not found." }, 404);
  }
  const next: ExtensionInstallRecord = {
    ...record,
    enabled: typeof body.enabled === "boolean" ? body.enabled : record.enabled,
    updatedAt: Date.now(),
  };
  await storage.upsertInstalledExtension(next);
  if (!next.enabled) {
    await closeExtensionSurfaceSessionsForExtension({ workspaceId: workspace.id, extensionId });
    if (listExtensionSurfaceSessions(workspace.id).length === 0) {
      await stopExtensionHost(workspace.id);
    }
  }
  return c.json({ extension: publicRecord(next), host: getExtensionHostStatus(workspace.id) });
});

extensionRoutes.delete("/api/workspaces/:workspaceId/extensions/:extensionId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const storage = await getStorage();
  const extensionId = normalizeExtensionId(c.req.param("extensionId"));
  const record = await getInstalledExtensionForWorkspace(workspace, extensionId);
  const removed = await storage.deleteInstalledExtension(
    workspace.id,
    extensionId
  );
  if (!removed) {
    return c.json({ error: "Extension not found." }, 404);
  }
  if (record?.installPath) {
    await fs.rm(record.installPath, { recursive: true, force: true }).catch(() => undefined);
  }
  await closeExtensionSurfaceSessionsForExtension({ workspaceId: workspace.id, extensionId });
  if (listExtensionSurfaceSessions(workspace.id).length === 0) {
    await stopExtensionHost(workspace.id);
  }
  return c.json({ ok: true, host: getExtensionHostStatus(workspace.id) });
});

extensionRoutes.patch("/api/workspaces/:workspaceId/extensions/:extensionId/settings", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{ settings?: Record<string, unknown> }>();
  if (!body.settings || typeof body.settings !== "object") {
    return c.json({ error: "Expected settings object." }, 400);
  }
  const record = await (await getStorage()).patchExtensionSettings(
    workspace.id,
    normalizeExtensionId(c.req.param("extensionId")),
    body.settings
  );
  if (!record) {
    return c.json({ error: "Extension not found." }, 404);
  }
  return c.json({ extension: publicRecord(record) });
});

extensionRoutes.post(
  "/api/workspaces/:workspaceId/extensions/:extensionId/permissions/:permission",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    if (workspace.id !== c.req.param("workspaceId")) {
      return c.json({ error: "Workspace mismatch." }, 400);
    }
    const body = await c.req.json<{ granted?: boolean; reason?: string }>();
    if (typeof body.granted !== "boolean") {
      return c.json({ error: "Expected granted boolean." }, 400);
    }
    const now = Date.now();
    const storage = await getStorage();
    const extensionId = normalizeExtensionId(c.req.param("extensionId"));
    await storage.upsertExtensionPermissionGrant({
      id: randomUUID(),
      workspaceId: workspace.id,
      extensionId,
      permission: c.req.param("permission") as ExtensionPermissionKind,
      granted: body.granted,
      reason: body.reason,
      createdAt: now,
      updatedAt: now,
    });
    const record = await getInstalledExtensionForWorkspace(workspace, extensionId);
    return c.json({ extension: record ? publicRecord(record) : null });
  }
);

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/host/start", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const status = await retainExtensionHost(workspace, "settings");
  return c.json({ host: status });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/host/release", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const status = await releaseExtensionHost(workspace.id, "settings");
  return c.json({ host: status });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/host/stop", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  await closeWorkspaceExtensionSurfaceSessions(workspace.id);
  return c.json({ host: await stopExtensionHost(workspace.id) });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/disable-all", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const storage = await getStorage();
  const extensions = await ensureInstalledExtensionsForWorkspace(workspace);
  const now = Date.now();
  await Promise.all(
    extensions.map((extension) =>
      storage.upsertInstalledExtension({
        ...extension,
        enabled: false,
        updatedAt: now,
      })
    )
  );
  await closeWorkspaceExtensionSurfaceSessions(workspace.id);
  const host = await stopExtensionHost(workspace.id);
  return c.json({
    extensions: (await ensureInstalledExtensionsForWorkspace(workspace)).map(publicRecord),
    host,
  });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/:extensionId/activate", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  await ensureInstalledExtensionsForWorkspace(workspace);
  const result = await activateExtension({
    workspace,
    extensionId: normalizeExtensionId(c.req.param("extensionId")),
  });
  return c.json({
    extension: publicRecord(result.record),
    result: result.result,
    host: result.status,
  });
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/:extensionId/surfaces/:surfaceId/resolve", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body: {
    title?: string;
    kind?: unknown;
    viewType?: string;
    placement?: unknown;
    sessionId?: string;
    theme?: unknown;
  } = await c.req.json().catch(() => ({}));
  await ensureInstalledExtensionsForWorkspace(workspace);
  const result = await ensureExtensionSurfaceSession({
    workspace,
    extensionId: normalizeExtensionId(c.req.param("extensionId")),
    surfaceId: c.req.param("surfaceId"),
    title: body.title,
    kind: asSurfaceKind(body.kind),
    viewType: body.viewType,
    placement: asSurfacePlacement(body.placement),
    sessionId: body.sessionId,
    theme: asThemeSnapshot(body.theme),
  });
  return c.json(result);
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/:extensionId/surfaces/:surfaceId/message", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body: { message?: unknown; sessionId?: string; title?: string } = await c.req.json().catch(() => ({}));
  await ensureInstalledExtensionsForWorkspace(workspace);
  const ensured = await ensureExtensionSurfaceSession({
    workspace,
    extensionId: normalizeExtensionId(c.req.param("extensionId")),
    surfaceId: c.req.param("surfaceId"),
    title: body.title,
  });
  const result = await deliverExtensionSurfaceSessionMessage({
    workspace,
    sessionId: body.sessionId ?? ensured.session.sessionId,
    message: body.message,
  });
  return c.json(result);
});

extensionRoutes.post("/api/workspaces/:workspaceId/extensions/commands/execute", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{ command?: string; args?: unknown[]; editorContext?: unknown }>();
  if (!body.command?.trim()) {
    return c.json({ error: "Expected command." }, 400);
  }
  await ensureInstalledExtensionsForWorkspace(workspace);
  const result = await executeExtensionCommand({
    workspace,
    command: body.command.trim(),
    args: body.args,
    editorContext: body.editorContext,
  });
  return c.json({ result: result.result, externalUrls: result.externalUrls, host: result.status });
});
