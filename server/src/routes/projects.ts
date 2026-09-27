import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { isProjectAgentIsolation } from "@cesium/core/projects";
import { asNumber, asRecord, asString } from "../lib/coerce.js";
import {
  CONTEXT_UPLOAD_MAX_BYTES,
  ProjectContextError,
  deleteContextFile,
  listContextEntries,
  readContextFile,
  seedProjectContext,
  statContextFile,
  writeContextFile,
  writeContextUpload,
} from "../lib/projects/context-store.js";
import {
  addProjectEngine,
  deleteProjectEngine,
  listProjectEngineSummaries,
  listProjectPeerTokens,
  mintProjectPeerToken,
  revokeProjectPeerToken,
} from "../lib/projects/engine-service.js";
import { ProjectsDisabledError, assertProjectsEnabled } from "../lib/projects/feature-flag.js";
import { listPreferenceLines, readPreferences, replacePreferences } from "../lib/projects/preferences.js";
import { getProjectContextDir } from "../lib/projects/paths.js";
import { PeerRequestError } from "../lib/projects/peer-client.js";
import {
  ProjectError,
  addProjectRepo,
  adoptProjectChild,
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
  setProjectChildArchived,
  stopProjectChild,
  updateProjectChild,
  updateProjectRepo,
  type ProjectRepoInput,
} from "../lib/projects/project-service.js";
import {
  ensureWorkerPrSubscriptions,
  listProjectSubscriptionSummaries,
  runProjectListeningTick,
  subscribeProject,
  unsubscribeProject,
  type SubscribeInput,
} from "../lib/projects/listening.js";
import {
  listProjectPullRequests,
  mergeProjectPullRequest,
  trackWorkerPullRequest,
} from "../lib/projects/pull-requests.js";
import { summarizeSubscription } from "../lib/projects/subscriptions-store.js";
import { GithubApiError } from "../lib/projects/github/client.js";

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
  if (error instanceof GithubApiError) {
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

/** A single `bytes=start-end` range, "invalid" when unsatisfiable, null when absent. */
function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) {
    return null;
  }
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    return "invalid";
  }
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix <= 0 || size === 0) {
      return "invalid";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    return "invalid";
  }
  return { start, end };
}

// Literal paths first: they would otherwise match `/api/projects/:id`.
projectRoutes.get(
  "/api/projects/engines",
  guarded(async (c) =>
    c.json({
      engines:
        c.req.query("detail") === "1"
          ? await listProjectEngines(null)
          : await listProjectEngineSummaries(),
    })
  )
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
  "/api/projects/preferences",
  guarded(async (c) => {
    await assertProjectsEnabled();
    const markdown = await readPreferences();
    return c.json({ markdown, lines: listPreferenceLines(markdown) });
  })
);

projectRoutes.put(
  "/api/projects/preferences",
  guarded(async (c) => {
    await assertProjectsEnabled();
    const body = await jsonBody(c);
    const markdown = await replacePreferences(typeof body.markdown === "string" ? body.markdown : "");
    return c.json({ markdown, lines: listPreferenceLines(markdown) });
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
                ...(settings.mergePolicy === "ask" || settings.mergePolicy === "when_green"
                  ? { mergePolicy: settings.mergePolicy }
                  : {}),
                ...(settings.prMode === "ready" || settings.prMode === "draft" ? { prMode: settings.prMode } : {}),
                ...(typeof settings.autoCreatePr === "boolean" ? { autoCreatePr: settings.autoCreatePr } : {}),
                ...(typeof settings.autoSubscribe === "boolean" ? { autoSubscribe: settings.autoSubscribe } : {}),
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

projectRoutes.patch(
  "/api/projects/:id/repos/:repoId",
  guarded(async (c) => {
    const body = await jsonBody(c);
    return c.json(
      await updateProjectRepo(param(c, "id"), param(c, "repoId"), {
        ...(Object.hasOwn(body, "baseBranch") ? { baseBranch: asString(body.baseBranch) ?? null } : {}),
        ...(Object.hasOwn(body, "githubRepo") ? { githubRepo: asString(body.githubRepo) ?? null } : {}),
      })
    );
  })
);

projectRoutes.get(
  "/api/projects/:id/prs",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    return c.json({ prs: await listProjectPullRequests(project.id) });
  })
);

/** The user merging from the Project page: their click is the authorization. */
projectRoutes.post(
  "/api/projects/:id/prs/merge",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const body = await jsonBody(c);
    return c.json(await mergeProjectPullRequest(project.id, { pr: asString(body.pr) ?? "", byUser: true }));
  })
);

/** Re-checks every worker's PR and polls the Project's subscriptions now. */
projectRoutes.post(
  "/api/projects/:id/prs/refresh",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    for (const child of project.children) {
      if (child.deletedAt == null && child.branch && child.githubRepo) {
        const tracked = await trackWorkerPullRequest(project.id, child.id).catch(() => null);
        if (tracked) {
          await ensureWorkerPrSubscriptions(project.id, child.id, tracked.pr).catch(() => undefined);
        }
      }
    }
    await runProjectListeningTick({ projectId: project.id, force: true });
    return c.json({ prs: await listProjectPullRequests(project.id) });
  })
);

projectRoutes.get(
  "/api/projects/:id/subscriptions",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    return c.json({
      subscriptions: await listProjectSubscriptionSummaries(project.id, {
        includeClosed: c.req.query("includeClosed") === "1",
      }),
    });
  })
);

projectRoutes.post(
  "/api/projects/:id/subscriptions",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const body = await jsonBody(c);
    const input: SubscribeInput =
      body.kind === "github_pr"
        ? {
            kind: "github_pr",
            repo: asString(body.repo) ?? "",
            number: asNumber(body.number) ?? 0,
            keepAfterClose: body.keepAfterClose === true,
          }
        : body.kind === "github_ci"
          ? { kind: "github_ci", repo: asString(body.repo) ?? "", branch: asString(body.branch) ?? "" }
          : body.kind === "timer"
            ? {
                kind: "timer",
                name: asString(body.name) ?? "",
                prompt: asString(body.prompt) ?? "",
                cron: asString(body.cron) ?? null,
                intervalSeconds: asNumber(body.everyMinutes) != null ? Math.round(asNumber(body.everyMinutes)! * 60) : null,
                delaySeconds: asNumber(body.inMinutes) != null ? Math.round(asNumber(body.inMinutes)! * 60) : null,
                once: !asString(body.cron) && asNumber(body.everyMinutes) == null,
              }
            : (() => {
                throw new ProjectError('kind must be "github_pr", "github_ci" or "timer".');
              })();
    const { subscription } = await subscribeProject(project.id, input, "user");
    return c.json({ subscription: summarizeSubscription(subscription, project.children) }, 201);
  })
);

projectRoutes.delete(
  "/api/projects/:id/subscriptions/:subscriptionId",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const closed = await unsubscribeProject(project.id, param(c, "subscriptionId"));
    return c.json({ subscription: summarizeSubscription(closed, project.children) });
  })
);

projectRoutes.get(
  "/api/projects/:id/context",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    await seedProjectContext(project.id, project.name);
    const { files, folders } = await listContextEntries(project.id);
    return c.json({ root: getProjectContextDir(project.id), files, folders });
  })
);

/**
 * Serves a context file's bytes (images, videos, logs) with Range support for
 * video seeking. The sandbox CSP keeps an uploaded SVG or page from running
 * script in the engine's origin.
 */
projectRoutes.get(
  "/api/projects/:id/context/raw",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const file = await statContextFile(project.id, c.req.query("path") ?? "");
    const headers: Record<string, string> = {
      "content-type": file.contentType,
      "accept-ranges": "bytes",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
    };
    const range = parseByteRange(c.req.header("range"), file.size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${file.size}` },
      });
    }
    if (file.size === 0) {
      return new Response(null, { status: 200, headers: { ...headers, "content-length": "0" } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const body = Readable.toWeb(createReadStream(file.absolute, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
      },
    });
  })
);

/** Stores the raw request body at `path` (drag-and-drop uploads, evidence). */
projectRoutes.post(
  "/api/projects/:id/context/upload",
  guarded(async (c) => {
    const project = await requireProject(param(c, "id"));
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > CONTEXT_UPLOAD_MAX_BYTES) {
      throw new ProjectContextError(`Uploads are capped at ${CONTEXT_UPLOAD_MAX_BYTES} bytes.`);
    }
    await seedProjectContext(project.id, project.name);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const written = await writeContextUpload(project.id, c.req.query("path") ?? "", bytes);
    return c.json({ written }, 201);
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
    const includeArchived = c.req.query("includeArchived") === "1";
    return c.json({
      agents: await listProjectChildren(param(c, "id"), { includeDeleted, includeArchived }),
    });
  })
);

projectRoutes.post(
  "/api/projects/:id/agents",
  guarded(async (c) => {
    const body = await jsonBody(c);
    if (body.isolation !== undefined && body.isolation !== null && !isProjectAgentIsolation(body.isolation)) {
      throw new ProjectError('isolation must be "worktree", "checkout" or "scratch".');
    }
    const { agent, warning } = await createProjectChild(
      param(c, "id"),
      {
        name: asString(body.name) ?? "",
        instructions: asString(body.instructions) ?? "",
        repo: asString(body.repo) ?? null,
        engine: asString(body.engine) ?? null,
        harness: asString(body.harness) ?? null,
        model: asString(body.model) ?? null,
        mode: asString(body.mode) ?? null,
        isolation: isProjectAgentIsolation(body.isolation) ? body.isolation : null,
        base: asString(body.base) ?? null,
      },
      "user"
    );
    return c.json({ agent, ...(warning ? { warning } : {}) }, 201);
  })
);

projectRoutes.post(
  "/api/projects/:id/agents/adopt",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const agent = await adoptProjectChild(param(c, "id"), {
      conversation: asString(body.conversation) ?? "",
      name: asString(body.name) ?? null,
    });
    return c.json({ agent }, 201);
  })
);

projectRoutes.post(
  "/api/projects/:id/agents/:agent/archive",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const agent = await setProjectChildArchived(
      param(c, "id"),
      param(c, "agent"),
      body.archived !== false
    );
    return c.json({ agent });
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
