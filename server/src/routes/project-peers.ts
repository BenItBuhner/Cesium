import {
  PROJECT_HOME_ENGINE_ID,
  normalizeProjectAgentName,
  type ProjectPeerTokenSummary,
} from "@cesium/core/projects";
import { Hono, type Context } from "hono";
import { readConversationRecord } from "../lib/agents/session-store.js";
import { asNumber, asRecord, asString } from "../lib/coerce.js";
import { getEngineInstanceId } from "../lib/engine-instance.js";
import {
  LocalChildHost,
  observeConversationRecord,
  type ChildCreateInput,
  type ChildCreateResult,
  type ChildRef,
} from "../lib/projects/child-host.js";
import { chooseChildModel, requireRunnableChildModel } from "../lib/projects/child-model.js";
import { homeEngineLabel } from "../lib/projects/engine-registry.js";
import { ProjectError } from "../lib/projects/errors.js";
import { isProjectsEnabled, ProjectsDisabledError } from "../lib/projects/feature-flag.js";
import type { PeerInfo, PeerWorkspaceInfo } from "../lib/projects/peer-client.js";
import { verifyPeerToken } from "../lib/projects/peer-tokens.js";
import {
  clampTranscriptTurns,
  listHomeHarnesses,
  resolveHarness,
} from "../lib/projects/project-service.js";
import { isEngineManagedWorkspace } from "../lib/standalone-chat-paths.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  listWorkspaces,
  type WorkspaceRecord,
} from "../lib/workspace-registry.js";

/**
 * The peer API: another engine (a Project's home) creates and drives Project
 * agents here with a peer token minted on this engine. Session auth does not
 * apply (see `authMiddleware`); every route requires the bearer token, and
 * child routes only reach conversations created with that same token.
 */

type PeerEnv = { Variables: { peerToken: ProjectPeerTokenSummary } };

export const projectPeerRoutes = new Hono<PeerEnv>();

const host = new LocalChildHost(PROJECT_HOME_ENGINE_ID);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROMPT_CHARS = 200_000;

function peerError(c: Context<PeerEnv>, error: unknown): Response {
  if (error instanceof ProjectsDisabledError) {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error instanceof ProjectError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  throw error;
}

function guarded(handler: (c: Context<PeerEnv>) => Promise<Response>) {
  return async (c: Context<PeerEnv>): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      return peerError(c, error);
    }
  };
}

async function jsonBody(c: Context<PeerEnv>): Promise<Record<string, unknown>> {
  return asRecord(await c.req.json().catch(() => null)) ?? {};
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : null;
}

projectPeerRoutes.use("/api/projects/peer/*", async (c, next) => {
  if (!(await isProjectsEnabled())) {
    const error = new ProjectsDisabledError();
    return c.json({ error: error.message, code: error.code }, 404);
  }
  const secret = bearerToken(c.req.header("authorization"));
  const token = secret ? await verifyPeerToken(secret) : null;
  if (!token) {
    return c.json(
      { error: "Missing or revoked peer token.", code: "peer_token_invalid" },
      401
    );
  }
  c.set("peerToken", token);
  await next();
});

function workspaceInfo(workspace: WorkspaceRecord): PeerWorkspaceInfo {
  return { id: workspace.id, name: workspace.name, root: workspace.root };
}

async function scopedChild(c: Context<PeerEnv>): Promise<ChildRef> {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const conversationId = c.req.param("conversationId") ?? "";
  const missing = new ProjectError(
    "No Project agent with that id was created here with this token.",
    404,
    "peer_child_not_found"
  );
  if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(conversationId)) {
    throw missing;
  }
  const record = await readConversationRecord(workspaceId, conversationId);
  const origin = record?.origin;
  if (origin?.kind !== "project-child" || origin.peerTokenId !== c.get("peerToken").id) {
    throw missing;
  }
  return { workspaceId, conversationId };
}

function requiredText(body: Record<string, unknown>, key: string, max: number): string {
  const value = typeof body[key] === "string" ? (body[key] as string) : "";
  if (!value.trim()) {
    throw new ProjectError(`${key} is required.`);
  }
  if (value.length > max) {
    throw new ProjectError(`${key} is too long (max ${max} characters).`);
  }
  return value;
}

/** This engine's name as the calling home knows it, for model and harness messages. */
function hostLabel(body: Record<string, unknown>): string {
  return asString(body.engineLabel)?.trim().slice(0, 80) || homeEngineLabel();
}

function safeId(body: Record<string, unknown>, key: string): string {
  const value = asString(body[key]) ?? "";
  if (!SAFE_ID.test(value)) {
    throw new ProjectError(`${key} must be a short id (letters, digits, "_" or "-").`);
  }
  return value;
}

async function resolvePlacement(value: unknown): Promise<ChildCreateInput["placement"]> {
  const placement = asRecord(value) ?? {};
  if (placement.kind === "scratch") {
    return { kind: "scratch", label: (asString(placement.label) ?? "Project agent").slice(0, 120) };
  }
  if (placement.kind === "workspace") {
    const workspaceId = asString(placement.workspaceId) ?? "";
    const workspace = SAFE_ID.test(workspaceId) ? await getWorkspaceById(workspaceId) : null;
    if (!workspace || isEngineManagedWorkspace(workspace)) {
      throw new ProjectError(`Unknown repository workspace on this engine: ${workspaceId}`);
    }
    return { kind: "workspace", workspaceId: workspace.id };
  }
  throw new ProjectError('placement.kind must be "workspace" or "scratch".');
}

projectPeerRoutes.get(
  "/api/projects/peer/info",
  guarded(async (c) => {
    const [harnesses, workspaces] = await Promise.all([listHomeHarnesses(), listWorkspaces()]);
    return c.json({
      instanceId: getEngineInstanceId(),
      label: homeEngineLabel(),
      tokenId: c.get("peerToken").id,
      harnesses,
      workspaces: workspaces
        .filter((workspace) => !isEngineManagedWorkspace(workspace))
        .map(workspaceInfo),
    } satisfies PeerInfo);
  })
);

projectPeerRoutes.post(
  "/api/projects/peer/workspaces",
  guarded(async (c) => {
    const root = asString((await jsonBody(c)).root);
    if (!root) {
      throw new ProjectError("root is required.");
    }
    let workspace: WorkspaceRecord;
    try {
      workspace = await ensureWorkspaceRegistered(root, undefined, { trackOpen: false });
    } catch (error) {
      throw new ProjectError(
        error instanceof Error ? error.message : `Cannot use ${root} as a repository.`
      );
    }
    if (isEngineManagedWorkspace(workspace)) {
      throw new ProjectError("Chat sandboxes and Project folders cannot be used as repositories.");
    }
    return c.json({ workspace: workspaceInfo(workspace) }, 201);
  })
);

projectPeerRoutes.post(
  "/api/projects/peer/children",
  guarded(async (c) => {
    const body = await jsonBody(c);
    const name = normalizeProjectAgentName(asString(body.name) ?? "");
    if (!name) {
      throw new ProjectError("name is required (letters, digits and dashes).");
    }
    const engine = hostLabel(body);
    const harness = await resolveHarness(asString(body.backendId), null, engine);
    const model = await chooseChildModel({
      harness: harness.id,
      requested: asString(body.modelId),
      engineLabel: engine,
    });
    const created = await host.create({
      projectId: safeId(body, "projectId"),
      childId: safeId(body, "childId"),
      name,
      promptText: requiredText(body, "promptText", MAX_PROMPT_CHARS),
      displayText: requiredText(body, "displayText", MAX_PROMPT_CHARS),
      placement: await resolvePlacement(body.placement),
      backendId: harness.id,
      modelId: model.modelId,
      mode: asString(body.mode) ?? null,
      peerTokenId: c.get("peerToken").id,
      ...(asString(body.homeLabel) ? { homeLabel: asString(body.homeLabel)!.slice(0, 80) } : {}),
    });
    return c.json({ ...created, modelWarning: model.warning } satisfies ChildCreateResult, 201);
  })
);

const CHILD_PATH = "/api/projects/peer/children/:workspaceId/:conversationId";

projectPeerRoutes.get(
  CHILD_PATH,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    const record = await readConversationRecord(ref.workspaceId, ref.conversationId);
    if (!record) {
      throw new ProjectError("That agent's conversation is gone.", 404, "peer_child_not_found");
    }
    return c.json(observeConversationRecord(record));
  })
);

projectPeerRoutes.get(
  `${CHILD_PATH}/digest`,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    const afterSeq = asNumber(Number(c.req.query("after"))) ?? 0;
    const throughSeq = asNumber(Number(c.req.query("through"))) ?? Number.MAX_SAFE_INTEGER;
    return c.json(await host.digestSince(ref, afterSeq, throughSeq));
  })
);

projectPeerRoutes.get(
  `${CHILD_PATH}/transcript`,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    return c.json({
      transcript: await host.transcript(ref, clampTranscriptTurns(c.req.query("turns"))),
    });
  })
);

projectPeerRoutes.post(
  `${CHILD_PATH}/messages`,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    const body = await jsonBody(c);
    const delivery = body.delivery === "steer" ? "steer" : "queue";
    const text = requiredText(body, "text", MAX_PROMPT_CHARS);
    return c.json({ delivery: await host.message(ref, text, delivery) });
  })
);

projectPeerRoutes.post(
  `${CHILD_PATH}/stop`,
  guarded(async (c) => {
    await host.stop(await scopedChild(c));
    return c.json({ ok: true });
  })
);

projectPeerRoutes.patch(
  CHILD_PATH,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    const body = await jsonBody(c);
    const requestedModel = asString(body.modelId);
    const modelId = requestedModel
      ? await requireRunnableChildModel({
          harness: (await readConversationRecord(ref.workspaceId, ref.conversationId))?.config.backendId ?? "",
          requested: requestedModel,
          engineLabel: hostLabel(body),
        })
      : null;
    await host.update(ref, {
      ...(asString(body.title) ? { title: asString(body.title)!.slice(0, 120) } : {}),
      ...(modelId ? { modelId } : {}),
      ...(asString(body.mode) ? { mode: asString(body.mode)! } : {}),
    });
    return c.json({ ok: true });
  })
);

projectPeerRoutes.delete(
  CHILD_PATH,
  guarded(async (c) => {
    await host.delete(await scopedChild(c));
    return c.json({ ok: true });
  })
);
