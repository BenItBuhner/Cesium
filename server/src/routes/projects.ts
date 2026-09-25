import { Hono, type Context } from "hono";
import { asNumber, asRecord, asString } from "../lib/coerce.js";
import {
  ProjectContextError,
  deleteContextFile,
  listContextFiles,
  readContextFile,
  writeContextFile,
} from "../lib/projects/context-store.js";
import {
  addProjectEngine,
  deleteProjectEngine,
  listProjectEngineSummaries,
  listProjectPeerTokens,
  mintProjectPeerToken,
  revokeProjectPeerToken,
} from "../lib/projects/engine-service.js";
import { ProjectsDisabledError } from "../lib/projects/feature-flag.js";
import { getProjectContextDir } from "../lib/projects/paths.js";
import { PeerRequestError } from "../lib/projects/peer-client.js";
import {
  ProjectError,
  addProjectRepo,
  createProject,
  createProjectChild,
  deleteProject,
  deleteProjectChild,
  getProjectChild,
  getProjectSnapshot,
  listProjectChildren,
  listProjectEngines,
  listProjects,
  messageProjectChild,
  patchProject,
  readProjectChildTranscript,
  removeProjectRepo,
  requireProject,
  stopProjectChild,
  updateProjectChild,
  type ProjectRepoInput,
} from "../lib/projects/project-service.js";

export const projectRoutes = new Hono();

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ProjectsDisabledError) {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error instanceof ProjectError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ProjectContextError) {
    return c.json({ error: error.message, code: "project_context_invalid" }, 400);
  }
  if (error instanceof PeerRequestError) {
    return c.json({ error: error.message, code: error.code }, 502);
  }
  throw error;
}

/** Maps Project-layer errors to JSON responses; anything else reaches the app error handler. */
function guarded(handler: (c: Context) => Promise<Response>) {
  return async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      return errorResponse(c, error);
    }
  };
}

function param(c: Context, key: string): string {
  return c.req.param(key) ?? "";
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return asRecord(body) ?? {};
}

function repoInput(value: unknown): ProjectRepoInput {
  const record = asRecord(value) ?? {};
  return {
    root: asString(record.root) ?? null,
    workspaceId: asString(record.workspaceId) ?? null,
    name: asString(record.name) ?? null,
    engineId: asString(record.engineId) ?? null,
  };
}

function nullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  return asString(record[key]) ?? null;
}

// Literal paths first: they would otherwise match `/api/projects/:id`.
projectRoutes.get(
  "/api/projects/engines",
  guarded(async (c) => c.json({ engines: await listProjectEngineSummaries() }))
);

projectRoutes.post(
  "/api/projects/engines",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const engine = await addProjectEngine({
      baseUrl: asString(body.baseUrl) ?? "",
      token: asString(body.token) ?? "",
      label: asString(body.label) ?? null,
    });
    return c.json({ engine }, 201);
  })
);

projectRoutes.delete(
  "/api/projects/engines/:engineId",
  guarded(async (c) => {
    await deleteProjectEngine(param(c, "engineId"));
    return c.json({ ok: true });
  })
);

projectRoutes.get(
  "/api/projects/peer-tokens",
  guarded(async (c) => c.json({ tokens: await listProjectPeerTokens() }))
);

projectRoutes.post(
  "/api/projects/peer-tokens",
  guarded(async (c) => {
    const body = await jsonBody(c);
    return c.json(await mintProjectPeerToken(asString(body.label) ?? ""), 201);
  })
);

projectRoutes.delete(
  "/api/projects/peer-tokens/:tokenId",
  guarded(async (c) => {
    await revokeProjectPeerToken(param(c, "tokenId"));
    return c.json({ ok: true });
  })
);

projectRoutes.get(
  "/api/projects",
  guarded(async (c) => c.json({ projects: await listProjects() }))
);

projectRoutes.post(
  "/api/projects",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const snapshot = await createProject({
      name: asString(body.name) ?? "",
      icon: asString(body.icon) ?? null,
      repos: Array.isArray(body.repos) ? body.repos.map(repoInput) : [],
      prompt: asString(body.prompt) ?? null,
      modelId: asString(body.modelId) ?? null,
    });
    return c.json(snapshot, 201);
  })
);

projectRoutes.get(
  "/api/projects/:id",
  guarded(async (c) => c.json(await getProjectSnapshot(param(c, "id"))))
);

projectRoutes.patch(
  "/api/projects/:id",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const settings = asRecord(body.settings);
    return c.json(
      await patchProject(param(c, "id"), {
        name: nullableString(body, "name"),
        icon: nullableString(body, "icon"),
        ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
        ...(settings
          ? {
              settings: {
                ...("defaultChildBackendId" in settings
                  ? { defaultChildBackendId: asString(settings.defaultChildBackendId) ?? null }
                  : {}),
                ...("defaultChildModelId" in settings
                  ? { defaultChildModelId: asString(settings.defaultChildModelId) ?? null }
                  : {}),
                ...(asNumber(settings.maxActiveChildren) !== undefined
                  ? { maxActiveChildren: asNumber(settings.maxActiveChildren) }
                  : {}),
              },
            }
          : {}),
      })
    );
  })
);

projectRoutes.delete(
  "/api/projects/:id",
  guarded(async (c) => {
    await deleteProject(param(c, "id"));
    return c.json({ ok: true });
  })
);

projectRoutes.post(
  "/api/projects/:id/repos",
  guarded(async (c) =>
    c.json(await addProjectRepo(param(c, "id"), repoInput(await jsonBody(c))), 201)
  )
);

projectRoutes.delete(
  "/api/projects/:id/repos/:repoId",
  guarded(async (c) => c.json(await removeProjectRepo(param(c, "id"), param(c, "repoId"))))
);

projectRoutes.get(
  "/api/projects/:id/context",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    return c.json({
      root: getProjectContextDir(project.id),
      files: await listContextFiles(project.id),
    });
  })
);

projectRoutes.get(
  "/api/projects/:id/context/file",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    return c.json(await readContextFile(project.id, c.req.query("path") ?? ""));
  })
);

projectRoutes.put(
  "/api/projects/:id/context/file",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const body = await jsonBody(c);
    const written = await writeContextFile(
      project.id,
      asString(body.path) ?? "",
      typeof body.content === "string" ? body.content : "",
      body.mode === "append" ? "append" : "replace"
    );
    return c.json({ written });
  })
);

projectRoutes.delete(
  "/api/projects/:id/context/file",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    await deleteContextFile(project.id, c.req.query("path") ?? "");
    return c.json({ ok: true });
  })
);

projectRoutes.get(
  "/api/projects/:id/agents",
  guarded(async (c) => {
    const includeDeleted = c.req.query("includeDeleted") === "1";
    return c.json({
      agents: await listProjectChildren(param(c, "id"), { includeDeleted }),
    });
  })
);

projectRoutes.post(
  "/api/projects/:id/agents",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const agent = await createProjectChild(
      param(c, "id"),
      {
        name: asString(body.name) ?? "",
        instructions: asString(body.instructions) ?? "",
        repo: asString(body.repo) ?? null,
        engine: asString(body.engine) ?? null,
        harness: asString(body.harness) ?? null,
        model: asString(body.model) ?? null,
        mode: asString(body.mode) ?? null,
      },
      "user"
    );
    return c.json({ agent }, 201);
  })
);

projectRoutes.get(
  "/api/projects/:id/agents/:agent",
  guarded(async (c) =>
    c.json({ agent: await getProjectChild(param(c, "id"), param(c, "agent")) })
  )
);

projectRoutes.patch(
  "/api/projects/:id/agents/:agent",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const agent = await updateProjectChild(param(c, "id"), param(c, "agent"), {
      name: asString(body.name) ?? null,
      model: asString(body.model) ?? null,
      mode: asString(body.mode) ?? null,
    });
    return c.json({ agent });
  })
);

projectRoutes.delete(
  "/api/projects/:id/agents/:agent",
  guarded(async (c) =>
    c.json(await deleteProjectChild(param(c, "id"), param(c, "agent")))
  )
);

projectRoutes.post(
  "/api/projects/:id/agents/:agent/messages",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const delivery = body.delivery === "steer" ? "steer" : "queue";
    return c.json(
      await messageProjectChild(
        param(c, "id"),
        param(c, "agent"),
        asString(body.text) ?? "",
        delivery
      )
    );
  })
);

projectRoutes.post(
  "/api/projects/:id/agents/:agent/stop",
  guarded(async (c) => c.json(await stopProjectChild(param(c, "id"), param(c, "agent"))))
);

projectRoutes.get(
  "/api/projects/:id/agents/:agent/transcript",
  guarded(async (c) =>
    c.json(
      await readProjectChildTranscript(
        param(c, "id"),
        param(c, "agent"),
        c.req.query("turns")
      )
    )
  )
);

projectRoutes.get(
  "/api/projects/:id/engines",
  guarded(async (c) => c.json({ engines: await listProjectEngines(param(c, "id")) }))
);
