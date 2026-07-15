import { Hono } from "hono";
import {
  ALL_MIGRATION_PHASES,
  gatherStats,
  migrate,
  openDriver,
  type MigrationPhase,
  type MigrationProgressEvent,
  type MigrationResult,
  type MigrationStats,
} from "../storage/migrate.js";
import { resolveConfiguredDriverKind } from "../storage/index.js";
import type { StorageDriver, StorageDriverKind } from "../storage/driver.js";

export const storageRoutes = new Hono();

/**
 * Only one migration may run at a time. This is process-local; deployments
 * with multiple servers should instead gate on a Redis lock — that can be
 * layered on when needed. For now the UI disables the button during a run
 * and the CLI is single-process.
 */
let activeMigration: Promise<unknown> | null = null;

function isValidDriverKind(value: unknown): value is StorageDriverKind {
  return value === "legacy-json" || value === "pg";
}

async function safeGatherStats(
  kind: StorageDriverKind
): Promise<{ stats: MigrationStats | null; available: boolean; error?: string }> {
  try {
    const driver = await openDriver(kind);
    try {
      const stats = await gatherStats(driver);
      return { stats, available: true };
    } finally {
      await driver.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      stats: null,
      available: false,
      error: (error as Error).message,
    };
  }
}

storageRoutes.get("/api/storage/status", async (c) => {
  const current = resolveConfiguredDriverKind();
  const [legacy, pg] = await Promise.all([
    safeGatherStats("legacy-json"),
    safeGatherStats("pg"),
  ]);
  return c.json({
    currentDriver: current,
    drivers: {
      "legacy-json": legacy,
      pg,
    },
    migrationRunning: activeMigration !== null,
  });
});

type MigrateRequestBody = {
  from?: StorageDriverKind;
  to?: StorageDriverKind;
  overwrite?: boolean;
  phases?: MigrationPhase[];
};

storageRoutes.post("/api/storage/migrate", async (c) => {
  if (activeMigration !== null) {
    return c.json(
      { error: "Another migration is already running." },
      409
    );
  }

  const body = (await c.req.json<MigrateRequestBody>().catch(() => null)) ?? {};
  if (!isValidDriverKind(body.from) || !isValidDriverKind(body.to)) {
    return c.json(
      { error: "Expected 'from' and 'to' to be 'legacy-json' or 'pg'." },
      400
    );
  }
  if (body.from === body.to) {
    return c.json({ error: "'from' and 'to' must differ." }, 400);
  }

  const validPhases: MigrationPhase[] = Array.isArray(body.phases)
    ? body.phases.filter((p): p is MigrationPhase =>
        (ALL_MIGRATION_PHASES as string[]).includes(p)
      )
    : [];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      };

      const migratePromise = (async () => {
        const from = body.from as StorageDriverKind;
        const to = body.to as StorageDriverKind;
        try {
          send({ type: "start", from, to, overwrite: body.overwrite === true });
          const result: MigrationResult = await migrate({
            from,
            to,
            overwrite: body.overwrite === true,
            phases: validPhases.length > 0 ? validPhases : undefined,
            onProgress: (event: MigrationProgressEvent) => {
              send({ type: "progress", ...event });
            },
          });
          send({ type: "result", result });
        } catch (error) {
          send({ type: "error", message: (error as Error).message });
        } finally {
          controller.close();
        }
      })();

      activeMigration = migratePromise;
      migratePromise.finally(() => {
        if (activeMigration === migratePromise) {
          activeMigration = null;
        }
      });
    },
    cancel() {
      // If the client disconnects, migration keeps running to avoid leaving
      // the target in an inconsistent state. It will still hit `finally` and
      // release `activeMigration`.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
});

type ExportLine =
  | { kind: "meta"; driver: StorageDriverKind; exportedAt: number }
  | { kind: "workspace"; data: unknown }
  | { kind: "workspace-profile"; data: unknown }
  | { kind: "global-settings"; data: unknown }
  | { kind: "auth-state"; data: unknown }
  | { kind: "auth-sessions"; data: unknown }
  | { kind: "workspace-session"; workspaceId: string; data: unknown }
  | {
      kind: "workspace-windows";
      workspaceId: string;
      data: unknown;
    }
  | {
      kind: "workspace-window-session";
      workspaceId: string;
      windowId: string;
      data: unknown;
    }
  | { kind: "agent-conversation"; data: unknown }
  | {
      kind: "agent-events";
      conversationId: string;
      data: unknown;
    }
  | { kind: "provider-cache"; backendId: string; data: unknown };

async function* streamExport(driver: StorageDriver): AsyncGenerator<ExportLine> {
  yield { kind: "meta", driver: driver.kind, exportedAt: Date.now() };

  const workspaces = await driver.listWorkspaces();
  for (const workspace of workspaces) yield { kind: "workspace", data: workspace };

  const profile = await driver.getWorkspaceProfile();
  yield { kind: "workspace-profile", data: profile };

  const globalSettings = await driver.getGlobalSettings();
  if (globalSettings) yield { kind: "global-settings", data: globalSettings };

  const authState = await driver.getAuthState();
  if (authState) yield { kind: "auth-state", data: authState };

  const sessions = await driver.listAuthSessions();
  yield { kind: "auth-sessions", data: sessions };

  for (const workspace of workspaces) {
    const session = await driver.getWorkspaceSession(workspace.id);
    if (session) {
      yield {
        kind: "workspace-session",
        workspaceId: workspace.id,
        data: session,
      };
    }

    const windows = await driver.listWorkspaceWindows(workspace.id);
    if (windows.length > 0) {
      yield {
        kind: "workspace-windows",
        workspaceId: workspace.id,
        data: windows,
      };
      for (const window of windows) {
        const windowSession = await driver.getWorkspaceWindowSession(
          workspace.id,
          window.id
        );
        if (windowSession) {
          yield {
            kind: "workspace-window-session",
            workspaceId: workspace.id,
            windowId: window.id,
            data: windowSession,
          };
        }
      }
    }
  }

  let cursor: string | null | undefined = null;
  while (true) {
    const page = await driver.listAgentConversations({
      cursor,
      limit: 200,
      includeArchived: true,
    });
    for (const record of page.records) {
      yield { kind: "agent-conversation", data: record };
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  let cursor2: string | null | undefined = null;
  while (true) {
    const page = await driver.listAgentConversations({
      cursor: cursor2,
      limit: 200,
      includeArchived: true,
    });
    for (const record of page.records) {
      let afterSeq = 0;
      while (true) {
        const batch = await driver.readAgentEvents({
          conversationId: record.id,
          afterSeq,
          limit: 500,
        });
        if (batch.length === 0) break;
        yield {
          kind: "agent-events",
          conversationId: record.id,
          data: batch,
        };
        afterSeq = batch[batch.length - 1].seq;
        if (batch.length < 500) break;
      }
    }
    if (!page.nextCursor) break;
    cursor2 = page.nextCursor;
  }

  for (const backendId of [
    "cesium-agent",
    "cursor-sdk",
    "opencode-server",
    "gemini-acp",
    "devin-acp",
    "codex-app-server",
    "claude-code-sdk",
    "pi-agent",
    "google-antigravity-cli",
  ] as const) {
    const entry = await driver.readProviderCache(backendId);
    if (entry) {
      yield { kind: "provider-cache", backendId, data: entry };
    }
  }
}

storageRoutes.get("/api/storage/export", async (c) => {
  const kindRaw = c.req.query("driver");
  const kind =
    kindRaw && isValidDriverKind(kindRaw) ? kindRaw : resolveConfiguredDriverKind();

  const driver = await openDriver(kind);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const line of streamExport(driver)) {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              kind: "error",
              message: (error as Error).message,
            }) + "\n"
          )
        );
      } finally {
        await driver.close().catch(() => undefined);
        controller.close();
      }
    },
  });

  const filename = `cesium-storage-${kind}-${Date.now()}.ndjson`;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});

type ImportLine = ExportLine | { kind: "error"; message: string };

function isAgentBackendId(value: string): boolean {
  return (
    value === "cesium-agent" ||
    value === "cursor-sdk" ||
    value === "opencode-server" ||
    value === "gemini-acp" ||
    value === "devin-acp" ||
    value === "codex-app-server" ||
    value === "claude-code-sdk" ||
    value === "pi-agent" ||
    value === "google-antigravity-cli"
  );
}

storageRoutes.post("/api/storage/import", async (c) => {
  const kindRaw = c.req.query("driver");
  const targetKind =
    kindRaw && isValidDriverKind(kindRaw) ? kindRaw : resolveConfiguredDriverKind();
  const overwrite = c.req.query("overwrite") === "1";

  const bodyText = await c.req.text();
  if (!bodyText.trim()) {
    return c.json({ error: "Expected NDJSON body." }, 400);
  }

  const driver = await openDriver(targetKind);
  const errors: Array<{ line: number; message: string }> = [];
  let applied = 0;
  try {
    const lines = bodyText.split(/\r?\n/).filter((line) => line.length > 0);
    const workspaceSeen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      let parsed: ImportLine;
      try {
        parsed = JSON.parse(raw) as ImportLine;
      } catch (error) {
        errors.push({
          line: i + 1,
          message: `Invalid JSON: ${(error as Error).message}`,
        });
        continue;
      }

      try {
        switch (parsed.kind) {
          case "meta":
            break;
          case "workspace": {
            const record = parsed.data as Parameters<
              StorageDriver["upsertWorkspace"]
            >[0];
            if (!overwrite && workspaceSeen.has(record.id)) break;
            await driver.upsertWorkspace(record);
            workspaceSeen.add(record.id);
            applied += 1;
            break;
          }
          case "workspace-profile": {
            const current = overwrite ? null : await driver.getWorkspaceProfile();
            if (current && Object.keys(current).length > 0) break;
            await driver.saveWorkspaceProfile(
              parsed.data as Parameters<StorageDriver["saveWorkspaceProfile"]>[0]
            );
            applied += 1;
            break;
          }
          case "global-settings": {
            if (!overwrite) {
              const current = await driver.getGlobalSettings();
              if (current !== null) break;
            }
            await driver.saveGlobalSettings(
              parsed.data as Parameters<StorageDriver["saveGlobalSettings"]>[0]
            );
            applied += 1;
            break;
          }
          case "auth-state": {
            if (!overwrite) {
              const current = await driver.getAuthState();
              if (current !== null) break;
            }
            await driver.saveAuthState(
              parsed.data as Parameters<StorageDriver["saveAuthState"]>[0]
            );
            applied += 1;
            break;
          }
          case "auth-sessions": {
            if (!overwrite) {
              const current = await driver.listAuthSessions();
              if (current.length > 0) break;
            }
            await driver.saveAuthSessions(
              parsed.data as Parameters<StorageDriver["saveAuthSessions"]>[0]
            );
            applied += 1;
            break;
          }
          case "workspace-session": {
            if (!overwrite) {
              const current = await driver.getWorkspaceSession(parsed.workspaceId);
              if (current) break;
            }
            await driver.saveWorkspaceSession(
              parsed.workspaceId,
              parsed.data as Parameters<StorageDriver["saveWorkspaceSession"]>[1]
            );
            applied += 1;
            break;
          }
          case "workspace-windows": {
            if (!overwrite) {
              const current = await driver.listWorkspaceWindows(parsed.workspaceId);
              if (current.length > 0) break;
            }
            await driver.saveWorkspaceWindows(
              parsed.workspaceId,
              parsed.data as Parameters<StorageDriver["saveWorkspaceWindows"]>[1]
            );
            applied += 1;
            break;
          }
          case "workspace-window-session": {
            if (!overwrite) {
              const current = await driver.getWorkspaceWindowSession(
                parsed.workspaceId,
                parsed.windowId
              );
              if (current) break;
            }
            await driver.saveWorkspaceWindowSession(
              parsed.workspaceId,
              parsed.windowId,
              parsed.data as Parameters<
                StorageDriver["saveWorkspaceWindowSession"]
              >[2]
            );
            applied += 1;
            break;
          }
          case "agent-conversation": {
            const record = parsed.data as Parameters<
              StorageDriver["upsertAgentConversation"]
            >[0];
            if (!overwrite) {
              const existing = await driver.getAgentConversation(record.id);
              if (existing) break;
            }
            await driver.upsertAgentConversation(record);
            applied += 1;
            break;
          }
          case "agent-events": {
            const rows = parsed.data as Array<{ seq: number } & Record<string, unknown>>;
            const events = rows.map((event) => {
              const { seq: _seq, ...rest } = event;
              return rest as unknown as Parameters<
                StorageDriver["appendAgentEvents"]
              >[0]["events"][number];
            });
            if (events.length === 0) break;
            await driver.appendAgentEvents({
              conversationId: parsed.conversationId,
              events,
            });
            applied += events.length;
            break;
          }
          case "provider-cache": {
            if (!isAgentBackendId(parsed.backendId)) break;
            if (!overwrite) {
              const current = await driver.readProviderCache(
                parsed.backendId as Parameters<StorageDriver["readProviderCache"]>[0]
              );
              if (current) break;
            }
            await driver.writeProviderCache(
              parsed.backendId as Parameters<StorageDriver["readProviderCache"]>[0],
              parsed.data as Parameters<StorageDriver["writeProviderCache"]>[1]
            );
            applied += 1;
            break;
          }
          case "error":
            break;
          default: {
            const exhaustive: never = parsed;
            throw new Error(`Unknown archive line kind: ${JSON.stringify(exhaustive)}`);
          }
        }
      } catch (error) {
        errors.push({ line: i + 1, message: (error as Error).message });
      }
    }
  } finally {
    await driver.close().catch(() => undefined);
  }

  return c.json({
    ok: errors.length === 0,
    applied,
    errors,
    targetDriver: targetKind,
    overwrite,
  });
});
