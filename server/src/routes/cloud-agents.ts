import { Hono } from "hono";
import {
  deleteCloudAgentConnection,
  getCloudAgentConnection,
  getCloudAgentSettingsPublic,
  patchCloudAgentSettings,
  setCloudAgentWebhookSecret,
  upsertCloudAgentConnection,
  upsertCloudAgentOAuthApp,
  type CloudAgentSettingsPatch,
} from "../lib/cloud-agents/settings.js";
import {
  CLOUD_AGENT_PROVIDER_LABELS,
  postCloudAgentUpdate,
  verifyCloudAgentToken,
} from "../lib/cloud-agents/connections.js";
import {
  buildCloudAgentOAuthCallbackUrl,
  buildCloudAgentWebhookUrl,
  cloudAgentOAuthFailureHtml,
  cloudAgentOAuthSuccessHtml,
  completeCloudAgentOAuthCallback,
  startCloudAgentOAuth,
} from "../lib/cloud-agents/oauth.js";
import { processCloudAgentWebhook } from "../lib/cloud-agents/webhooks.js";
import {
  cancelCloudAgentTask,
  completeCloudAgentTask,
  dispatchCloudAgentTask,
  ingestCloudAgentAssignment,
  listCloudAgentTaskArtifacts,
  steerCloudAgentTask,
} from "../lib/cloud-agents/dispatcher.js";
import {
  appendCloudAgentTaskTimeline,
  createCloudAgentTask,
  deleteCloudAgentTask,
  getCloudAgentTask,
  listCloudAgentTasks,
} from "../lib/cloud-agents/tasks.js";
import {
  CLOUD_AGENT_PROVIDER_IDS,
  isCloudAgentProviderId,
  type CloudAgentExecutionMode,
  type CloudAgentTaskStatus,
} from "../lib/cloud-agents/types.js";
import type { AgentBackendId } from "../lib/agents/types.js";

export const cloudAgentRoutes = new Hono();

function publicOriginFromRequest(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string {
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

function isExecutionMode(value: unknown): value is CloudAgentExecutionMode {
  return value === "isolated" || value === "local";
}

cloudAgentRoutes.get("/api/cloud-agents/settings", async (c) => {
  const origin = publicOriginFromRequest(c);
  const settings = await getCloudAgentSettingsPublic();
  return c.json({
    settings,
    endpoints: {
      oauthCallbackUrl: buildCloudAgentOAuthCallbackUrl(origin),
      webhooks: Object.fromEntries(
        CLOUD_AGENT_PROVIDER_IDS.map((providerId) => [
          providerId,
          buildCloudAgentWebhookUrl(origin, providerId),
        ])
      ),
    },
  });
});

cloudAgentRoutes.patch("/api/cloud-agents/settings", async (c) => {
  const body = await c.req.json<CloudAgentSettingsPatch>();
  const settings = await patchCloudAgentSettings({
    ...(body.defaults ? { defaults: body.defaults } : {}),
    ...(Array.isArray(body.routingRules) ? { routingRules: body.routingRules } : {}),
  });
  return c.json({ ok: true, settings });
});

cloudAgentRoutes.put("/api/cloud-agents/connections/:providerId/token", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  const body = await c.req.json<{ accessToken?: string; webhookSecret?: string }>();
  const accessToken = body.accessToken?.trim();
  if (!accessToken) {
    return c.json({ error: "Expected accessToken." }, 400);
  }
  try {
    const identity = await verifyCloudAgentToken(providerId, accessToken);
    const settings = await upsertCloudAgentConnection({
      providerId,
      method: "token",
      accessToken,
      ...(body.webhookSecret !== undefined ? { webhookSecret: body.webhookSecret } : {}),
      accountLabel: identity.accountLabel,
      ...(identity.scopes ? { scopes: identity.scopes } : {}),
    });
    return c.json({ ok: true, settings });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Failed to verify the ${CLOUD_AGENT_PROVIDER_LABELS[providerId]} token.`;
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.put("/api/cloud-agents/connections/:providerId/webhook-secret", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  const body = await c.req.json<{ webhookSecret?: string | null }>();
  try {
    const settings = await setCloudAgentWebhookSecret({
      providerId,
      webhookSecret: body.webhookSecret ?? null,
    });
    return c.json({ ok: true, settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save webhook secret.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.delete("/api/cloud-agents/connections/:providerId", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  const settings = await deleteCloudAgentConnection(providerId);
  return c.json({ ok: true, settings });
});

cloudAgentRoutes.put("/api/cloud-agents/connections/:providerId/oauth-app", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  const body = await c.req.json<{ clientId?: string; clientSecret?: string }>();
  if (!body.clientId?.trim() || !body.clientSecret?.trim()) {
    return c.json({ error: "Expected clientId and clientSecret." }, 400);
  }
  const settings = await upsertCloudAgentOAuthApp({
    providerId,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
  });
  return c.json({ ok: true, settings });
});

cloudAgentRoutes.get("/api/cloud-agents/connections/:providerId/oauth/start", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  try {
    const result = await startCloudAgentOAuth({
      providerId,
      publicOrigin: publicOriginFromRequest(c),
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start OAuth.";
    return c.json({ error: message }, 400);
  }
});

/** Exempted from auth middleware: browser redirect target from the provider. */
cloudAgentRoutes.get("/api/cloud-agents/oauth/callback", async (c) => {
  const error = c.req.query("error")?.trim();
  if (error) {
    return c.html(cloudAgentOAuthFailureHtml(error), 400);
  }
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  if (!code || !state) {
    return c.html(cloudAgentOAuthFailureHtml("Missing authorization code or state."), 400);
  }
  try {
    const result = await completeCloudAgentOAuthCallback({ code, state });
    return c.html(
      cloudAgentOAuthSuccessHtml(CLOUD_AGENT_PROVIDER_LABELS[result.providerId])
    );
  } catch (callbackError) {
    const message =
      callbackError instanceof Error ? callbackError.message : "OAuth callback failed.";
    return c.html(cloudAgentOAuthFailureHtml(message), 400);
  }
});

/**
 * Inbound provider webhooks. Exempted from session auth; verified with the
 * stored per-provider webhook secret instead (rejected on bad signatures).
 */
cloudAgentRoutes.post("/api/cloud-agents/webhooks/:providerId", async (c) => {
  const providerId = c.req.param("providerId");
  if (!isCloudAgentProviderId(providerId)) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 400);
  }
  const rawBody = await c.req.text();
  const connection = await getCloudAgentConnection(providerId);
  const result = processCloudAgentWebhook({
    providerId,
    rawBody,
    headers: {
      "x-hub-signature-256": c.req.header("x-hub-signature-256"),
      "x-github-event": c.req.header("x-github-event"),
      "linear-signature": c.req.header("linear-signature"),
      "x-slack-signature": c.req.header("x-slack-signature"),
      "x-slack-request-timestamp": c.req.header("x-slack-request-timestamp"),
    },
    webhookSecret: connection?.webhookSecret ?? null,
  });

  switch (result.kind) {
    case "challenge":
      return c.json({ challenge: result.challenge });
    case "rejected":
      return c.json({ error: result.reason }, 401);
    case "ignored":
      return c.json({ ok: true, ignored: true, reason: result.reason });
    case "assignment": {
      const { task, dispatched, steered, ignoredReason } =
        await ingestCloudAgentAssignment(result.assignment);
      if (!task) {
        return c.json({ ok: true, ignored: true, reason: ignoredReason });
      }
      return c.json(
        { ok: true, taskId: task.id, dispatched, ...(steered ? { steered } : {}) },
        201
      );
    }
  }
});

cloudAgentRoutes.get("/api/cloud-agents/tasks", async (c) => {
  const workspaceId = c.req.query("workspaceId")?.trim();
  const status = c.req.query("status")?.trim();
  const tasks = await listCloudAgentTasks({
    ...(workspaceId ? { workspaceId } : {}),
    ...(status ? { status: status as CloudAgentTaskStatus } : {}),
  });
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ tasks });
});

cloudAgentRoutes.post("/api/cloud-agents/tasks", async (c) => {
  const body = await c.req.json<{
    title?: string;
    prompt?: string;
    workspaceId?: string;
    backendId?: AgentBackendId;
    modelId?: string;
    executionMode?: CloudAgentExecutionMode;
    dispatch?: boolean;
  }>();
  if (!body.title?.trim()) {
    return c.json({ error: "Expected title." }, 400);
  }
  const task = await createCloudAgentTask({
    title: body.title.trim(),
    prompt: body.prompt?.trim() ?? "",
    status: "inbox",
    source: { providerId: "manual" },
    workspaceId: body.workspaceId?.trim() || null,
    conversationId: null,
    backendId: body.backendId ?? null,
    modelId: body.modelId?.trim() || null,
    executionMode: isExecutionMode(body.executionMode) ? body.executionMode : "isolated",
    timeline: [{ at: Date.now(), kind: "received", message: "Created manually." }],
  });
  if (body.dispatch) {
    try {
      const dispatched = await dispatchCloudAgentTask(task.id, {});
      return c.json({ ok: true, task: dispatched }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dispatch failed.";
      return c.json({ ok: false, task: await getCloudAgentTask(task.id), error: message }, 400);
    }
  }
  return c.json({ ok: true, task }, 201);
});

cloudAgentRoutes.get("/api/cloud-agents/tasks/:taskId", async (c) => {
  const task = await getCloudAgentTask(c.req.param("taskId"));
  if (!task) {
    return c.json({ error: "Unknown task." }, 404);
  }
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json({ task });
});

cloudAgentRoutes.post("/api/cloud-agents/tasks/:taskId/dispatch", async (c) => {
  const body = await c.req
    .json<{
      workspaceId?: string;
      backendId?: AgentBackendId;
      modelId?: string;
      executionMode?: CloudAgentExecutionMode;
    }>()
    .catch(() => ({}) as Record<string, never>);
  try {
    const task = await dispatchCloudAgentTask(c.req.param("taskId"), {
      ...(body.workspaceId?.trim() ? { workspaceId: body.workspaceId.trim() } : {}),
      ...(body.backendId ? { backendId: body.backendId } : {}),
      ...(body.modelId?.trim() ? { modelId: body.modelId.trim() } : {}),
      ...(isExecutionMode(body.executionMode) ? { executionMode: body.executionMode } : {}),
    });
    return c.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dispatch failed.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.post("/api/cloud-agents/tasks/:taskId/steer", async (c) => {
  const body = await c.req.json<{ text?: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: "Expected steering text." }, 400);
  }
  try {
    const task = await steerCloudAgentTask(c.req.param("taskId"), body.text.trim());
    return c.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Steer failed.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.post("/api/cloud-agents/tasks/:taskId/cancel", async (c) => {
  try {
    const task = await cancelCloudAgentTask(c.req.param("taskId"));
    return c.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cancel failed.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.post("/api/cloud-agents/tasks/:taskId/complete", async (c) => {
  try {
    const task = await completeCloudAgentTask(c.req.param("taskId"));
    return c.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Complete failed.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.get("/api/cloud-agents/tasks/:taskId/artifacts", async (c) => {
  try {
    const artifacts = await listCloudAgentTaskArtifacts(c.req.param("taskId"));
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({ artifacts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list artifacts.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.post("/api/cloud-agents/tasks/:taskId/post-update", async (c) => {
  const body = await c.req
    .json<{ message?: string; includeArtifacts?: boolean }>()
    .catch(() => ({}) as Record<string, never>);
  const task = await getCloudAgentTask(c.req.param("taskId"));
  if (!task) {
    return c.json({ error: "Unknown task." }, 404);
  }
  try {
    let message = body.message?.trim() || `Cloud Agent update for "${task.title}".`;
    if (body.includeArtifacts) {
      const artifacts = await listCloudAgentTaskArtifacts(task.id);
      if (artifacts.length > 0) {
        message += `\n\nDemonstration artifacts (${artifacts.length}):\n${artifacts
          .map((artifact) => `- ${artifact.name}`)
          .join("\n")}`;
      }
    }
    const result = await postCloudAgentUpdate(task, message);
    const updated = await appendCloudAgentTaskTimeline(task.id, {
      kind: "update_posted",
      message: result.detail,
    });
    return c.json({ ok: true, task: updated, detail: result.detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to post update.";
    return c.json({ error: message }, 400);
  }
});

cloudAgentRoutes.delete("/api/cloud-agents/tasks/:taskId", async (c) => {
  await deleteCloudAgentTask(c.req.param("taskId"));
  return c.json({ ok: true });
});
