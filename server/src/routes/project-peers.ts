import {
  PROJECT_HOME_ENGINE_ID,
  normalizeProjectAgentName,
  type ProjectPeerTokenSummary,
} from "@cesium/core/projects";
import { promises as fs } from "node:fs";
import path from "node:path";
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
import { ProjectContextError } from "../lib/projects/context-store.js";
import {
  dropMirrorFeedProject,
  expectOwnMirrorWrite,
  waitForMirrorChanges,
} from "../lib/projects/context-feed.js";
import {
  CONTEXT_FILE_ABSENT,
  CONTEXT_SYNC_FILE_MAX_BYTES,
  contextFileIn,
  contextManifest,
  currentSha256,
  deleteContextFileIn,
  forgetContextHashes,
  writeContextBytesIn,
} from "../lib/projects/context-sync.js";
import type { HelperBriefInput } from "../lib/projects/helper-brief.js";
import { getPeerMirrorContextDir } from "../lib/projects/paths.js";
import type { WorkerBriefInput } from "../lib/projects/worker-brief.js";
import { homeEngineLabel } from "../lib/projects/engine-registry.js";
import { ProjectError } from "../lib/projects/errors.js";
import { isProjectsEnabled, ProjectsDisabledError } from "../lib/projects/feature-flag.js";
import type { PeerContextChanges, PeerInfo, PeerWorkspaceInfo } from "../lib/projects/peer-client.js";
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

/** A Project agent this token created here; anything else is reported as missing. */
async function tokenChild(workspaceId: string, conversationId: string, tokenId: string): Promise<ChildRef> {
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
  if (origin?.kind !== "project-child" || origin.peerTokenId !== tokenId) {
    throw missing;
  }
  return { workspaceId, conversationId };
}

function scopedChild(c: Context<PeerEnv>): Promise<ChildRef> {
  return tokenChild(c.req.param("workspaceId") ?? "", c.req.param("conversationId") ?? "", c.get("peerToken").id);
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

const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function repoWorkspace(value: unknown): Promise<WorkspaceRecord> {
  const workspaceId = asString(value) ?? "";
  const workspace = SAFE_ID.test(workspaceId) ? await getWorkspaceById(workspaceId) : null;
  if (!workspace || isEngineManagedWorkspace(workspace)) {
    throw new ProjectError(`Unknown repository workspace on this engine: ${workspaceId}`);
  }
  return workspace;
}

async function resolvePlacement(value: unknown, tokenId: string): Promise<ChildCreateInput["placement"]> {
  const placement = asRecord(value) ?? {};
  if (placement.kind === "snapshot") {
    const name = asString(placement.name) ?? "";
    const baseBranch = asString(placement.baseBranch)?.trim() || null;
    if (!SAFE_ID.test(name) || (baseBranch && !BRANCH_PATTERN.test(baseBranch))) {
      throw new ProjectError("placement.name must be a short id and placement.baseBranch a plain branch name.");
    }
    const base = asRecord(placement.base);
    const baseRef = asString(base?.baseRef) ?? "";
    const sha = asString(base?.sha) ?? "";
    if (base && (!BRANCH_PATTERN.test(baseRef) || !SHA_PATTERN.test(sha))) {
      throw new ProjectError("placement.base needs a branch name and a full commit sha.");
    }
    return {
      kind: "snapshot",
      workspaceId: (await repoWorkspace(placement.workspaceId)).id,
      baseBranch,
      name,
      base: base ? { baseRef, sha } : null,
    };
  }
  if (placement.kind === "agent") {
    // Only the folder of an agent this same token created here.
    const ref = await tokenChild(asString(placement.workspaceId) ?? "", asString(placement.conversationId) ?? "", tokenId);
    return { kind: "agent", ...ref };
  }
  if (placement.kind === "scratch") {
    return { kind: "scratch", label: (asString(placement.label) ?? "Project agent").slice(0, 120) };
  }
  if (placement.kind === "workspace") {
    return { kind: "workspace", workspaceId: (await repoWorkspace(placement.workspaceId)).id };
  }
  if (placement.kind === "worktree") {
    const branch = asString(placement.branch) ?? "";
    const baseBranch = asString(placement.baseBranch)?.trim() || null;
    if (!BRANCH_PATTERN.test(branch) || (baseBranch && !BRANCH_PATTERN.test(baseBranch))) {
      throw new ProjectError("placement.branch and placement.baseBranch must be plain branch names.");
    }
    return {
      kind: "worktree",
      workspaceId: (await repoWorkspace(placement.workspaceId)).id,
      branch,
      baseBranch,
      fallbackToCheckout: placement.fallbackToCheckout === true,
    };
  }
  throw new ProjectError('placement.kind must be "worktree", "workspace", "scratch", "snapshot" or "agent".');
}

/**
 * The home's helper brief. A browser check saves its evidence in this
 * engine's mirror of the Project context when the home synced it here
 * (`contextSync`), else it only lists the files in its report.
 */
async function helperBriefInput(value: unknown, name: string, mirrorDir: string): Promise<HelperBriefInput | undefined> {
  const brief = asRecord(value);
  if (!brief) {
    return undefined;
  }
  const projectName = (asString(brief.projectName) ?? "Project").slice(0, 120);
  if (brief.kind === "explore") {
    return {
      kind: "explore",
      projectName,
      helperName: name,
      repoName: (asString(brief.repoName) ?? "repository").slice(0, 120),
      question: requiredText(brief, "question", MAX_PROMPT_CHARS),
    };
  }
  if (brief.kind === "browser") {
    const url = asString(brief.url)?.trim() || null;
    if (url && !/^https?:\/\//i.test(url)) {
      throw new ProjectError("helperBrief.url must start with http:// or https://.");
    }
    const agent = asRecord(brief.agent);
    const agentName = asString(agent?.name)?.trim().slice(0, 80) ?? "";
    const mediaDir = brief.contextSync === true ? path.join(mirrorDir, "media", name) : null;
    if (mediaDir) {
      await fs.mkdir(mediaDir, { recursive: true });
    }
    return {
      kind: "browser",
      projectName,
      helperName: name,
      what: requiredText(brief, "what", MAX_PROMPT_CHARS),
      url,
      agent: agentName ? { name: agentName, branch: asString(agent?.branch)?.slice(0, 200) ?? null } : null,
      mediaDir,
    };
  }
  throw new ProjectError('helperBrief.kind must be "explore" or "browser".');
}

/**
 * The home's worker brief. Its context folder is the home's; when the home
 * has synced the Project context here (`contextSync`), the agent works in
 * this engine's mirror of it instead, else it has no copy.
 */
function briefInput(value: unknown, name: string, mirrorDir: string | null): WorkerBriefInput | undefined {
  const brief = asRecord(value);
  if (!brief) {
    return undefined;
  }
  const instructions = typeof brief.instructions === "string" ? brief.instructions : "";
  if (!instructions.trim()) {
    throw new ProjectError("brief.instructions is required.");
  }
  if (instructions.length > MAX_PROMPT_CHARS) {
    throw new ProjectError(`brief.instructions is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  return {
    projectName: (asString(brief.projectName) ?? "Project").slice(0, 120),
    agentName: name,
    instructions,
    repoName: asString(brief.repoName)?.slice(0, 120) ?? null,
    contextDir: brief.contextSync === true ? mirrorDir : null,
    contextIsMirror: brief.contextSync === true && mirrorDir != null,
    contextEngine: (asString(brief.contextEngine) ?? "the Project's home engine").slice(0, 80),
    preferences: Array.isArray(brief.preferences)
      ? brief.preferences
          .filter((line): line is string => typeof line === "string")
          .map((line) => line.slice(0, 500))
          .slice(0, 50)
      : [],
  };
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
    const projectId = safeId(body, "projectId");
    const placement = await resolvePlacement(body.placement, c.get("peerToken").id);
    const mirrorDir = getPeerMirrorContextDir(c.get("peerToken").id, projectId);
    const brief = briefInput(body.brief, name, mirrorDir);
    if (brief?.contextDir) {
      await fs.mkdir(brief.contextDir, { recursive: true });
    }
    const helperBrief = brief ? undefined : await helperBriefInput(body.helperBrief, name, mirrorDir);
    let created: ChildCreateResult;
    try {
      created = await host.create({
        projectId,
        childId: safeId(body, "childId"),
        name,
        ...(brief
          ? { brief }
          : helperBrief
            ? { helperBrief }
            : { promptText: requiredText(body, "promptText", MAX_PROMPT_CHARS) }),
        displayText: requiredText(body, "displayText", MAX_PROMPT_CHARS),
        placement,
        backendId: harness.id,
        modelId: model.modelId,
        mode: asString(body.mode) ?? null,
        peerTokenId: c.get("peerToken").id,
        ...(asString(body.homeLabel) ? { homeLabel: asString(body.homeLabel)!.slice(0, 80) } : {}),
        engineLabel: engine,
        autoApprove: body.autoApprove === true,
        readOnly: body.readOnly === true,
      });
    } catch (error) {
      if (helperBrief?.kind === "browser" && helperBrief.mediaDir) {
        await fs.rmdir(helperBrief.mediaDir).catch(() => undefined);
      }
      throw error;
    }
    return c.json({ ...created, modelWarning: model.warning } satisfies ChildCreateResult, 201);
  })
);

const CONTEXT_PATH = "/api/projects/peer/context/:projectId";

/** This token's mirror of the named Project's context. */
function mirrorRoot(c: Context<PeerEnv>): string {
  const projectId = c.req.param("projectId") ?? "";
  if (!SAFE_ID.test(projectId)) {
    throw new ProjectError("Invalid project id.", 400);
  }
  return getPeerMirrorContextDir(c.get("peerToken").id, projectId);
}

function contextError(error: unknown): never {
  if (error instanceof ProjectContextError) {
    throw new ProjectError(error.message, 400);
  }
  throw error;
}

/** With `ifMatch`, the home's write or delete only lands on the version it listed. */
async function assertUnchangedSinceListed(absolute: string, relative: string, ifMatch: string | undefined): Promise<void> {
  if (ifMatch && ((await currentSha256(absolute)) ?? CONTEXT_FILE_ABSENT) !== ifMatch) {
    throw new ProjectError(`${relative} changed here since the home listed it.`, 409, "context_changed");
  }
}

projectPeerRoutes.get(
  `${CONTEXT_PATH}/manifest`,
  guarded(async (c) => {
    const root = mirrorRoot(c);
    await fs.mkdir(root, { recursive: true });
    return c.json({ files: await contextManifest(root) });
  })
);

projectPeerRoutes.get(
  `${CONTEXT_PATH}/file`,
  guarded(async (c) => {
    const root = mirrorRoot(c);
    const { absolute, relative } = await contextFileIn(root, c.req.query("path") ?? "").catch(contextError);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) {
      throw new ProjectError(`No file at ${relative} in the mirror.`, 404);
    }
    return new Response(new Uint8Array(await fs.readFile(absolute)), {
      headers: { "content-type": "application/octet-stream", "content-length": String(stat.size) },
    });
  })
);

projectPeerRoutes.put(
  `${CONTEXT_PATH}/file`,
  guarded(async (c) => {
    const root = mirrorRoot(c);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > CONTEXT_SYNC_FILE_MAX_BYTES) {
      throw new ProjectError(`Files over ${CONTEXT_SYNC_FILE_MAX_BYTES} bytes are not synced.`, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const mtime = Number(c.req.query("mtime"));
    const { absolute, relative } = await contextFileIn(root, c.req.query("path") ?? "").catch(contextError);
    await assertUnchangedSinceListed(absolute, relative, c.req.query("ifMatch"));
    if (Number.isFinite(mtime)) {
      expectOwnMirrorWrite(c.get("peerToken").id, absolute, { size: bytes.byteLength, mtimeMs: mtime });
    }
    await writeContextBytesIn(root, c.req.query("path") ?? "", bytes, Number.isFinite(mtime) ? mtime : null).catch(
      contextError
    );
    return c.json({ ok: true, size: bytes.byteLength });
  })
);

projectPeerRoutes.delete(
  `${CONTEXT_PATH}/file`,
  guarded(async (c) => {
    const root = mirrorRoot(c);
    const { absolute, relative } = await contextFileIn(root, c.req.query("path") ?? "").catch(contextError);
    await assertUnchangedSinceListed(absolute, relative, c.req.query("ifMatch"));
    expectOwnMirrorWrite(c.get("peerToken").id, absolute, "absent");
    await deleteContextFileIn(root, c.req.query("path") ?? "").catch(contextError);
    return c.json({ ok: true });
  })
);

/** The home deleted the Project: drop this token's whole copy of its context. */
projectPeerRoutes.delete(
  CONTEXT_PATH,
  guarded(async (c) => {
    const root = mirrorRoot(c);
    dropMirrorFeedProject(c.get("peerToken").id, c.req.param("projectId") ?? "");
    await fs.rm(path.dirname(root), { recursive: true, force: true });
    forgetContextHashes(root);
    return c.json({ ok: true });
  })
);

/**
 * Answers when a context mirror this token holds changes (an agent here wrote
 * to it) after the home's cursor, or empty after `wait` ms. The home keeps
 * one of these open to sync those Projects right away.
 */
projectPeerRoutes.get(
  "/api/projects/peer/context-changes",
  guarded(async (c) => {
    const cursor = Number(c.req.query("cursor"));
    const wait = Number(c.req.query("wait"));
    const changes = await waitForMirrorChanges(c.get("peerToken").id, {
      feed: c.req.query("feed") || null,
      cursor: Number.isFinite(cursor) ? cursor : -1,
      waitMs: Number.isFinite(wait) ? wait : 0,
      signal: c.req.raw.signal,
    });
    if (!changes) {
      return c.json({ error: "Missing or revoked peer token.", code: "peer_token_invalid" }, 401);
    }
    return c.json(changes satisfies PeerContextChanges);
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

projectPeerRoutes.get(
  `${CHILD_PATH}/reply`,
  guarded(async (c) => c.json({ reply: await host.lastReply(await scopedChild(c)) }))
);

projectPeerRoutes.get(
  `${CHILD_PATH}/changes`,
  guarded(async (c) => {
    const ref = await scopedChild(c);
    const base = c.req.query("base") ?? "";
    if (base && !SHA_PATTERN.test(base)) {
      throw new ProjectError("base must be a full commit sha.");
    }
    return c.json({ files: await host.changedFiles(ref, base || null) });
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
    await host.delete(await scopedChild(c), { keepWorkspace: c.req.query("keepWorkspace") === "1" });
    return c.json({ ok: true });
  })
);
