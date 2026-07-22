import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-cloud-agents-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  settingsModule,
  webhooksModule,
  tasksModule,
  dispatcherModule,
  oauthModule,
  routesModule,
] = await Promise.all([
  import("../src/lib/cloud-agents/settings.js"),
  import("../src/lib/cloud-agents/webhooks.js"),
  import("../src/lib/cloud-agents/tasks.js"),
  import("../src/lib/cloud-agents/dispatcher.js"),
  import("../src/lib/cloud-agents/oauth.js"),
  import("../src/routes/cloud-agents.js"),
]);

const {
  deleteCloudAgentConnection,
  getCloudAgentConnection,
  getCloudAgentSettings,
  getCloudAgentSettingsPublic,
  patchCloudAgentSettings,
  upsertCloudAgentConnection,
  upsertCloudAgentOAuthApp,
} = settingsModule;
const {
  processCloudAgentWebhook,
  verifyGithubSignature,
  verifyLinearSignature,
  verifySlackSignature,
} = webhooksModule;
const {
  appendCloudAgentTaskTimeline,
  createCloudAgentTask,
  deleteCloudAgentTask,
  findCloudAgentTaskByConversation,
  getCloudAgentTask,
  listCloudAgentTasks,
  updateCloudAgentTask,
} = tasksModule;
const {
  buildCloudAgentBranchName,
  buildCloudAgentTaskPrompt,
  dispatchCloudAgentTask,
  resolveCloudAgentRoute,
} = dispatcherModule;
const {
  buildCloudAgentAuthorizeUrl,
  buildCloudAgentOAuthCallbackUrl,
  buildCloudAgentWebhookUrl,
  cloudAgentOAuthSuccessHtml,
  startCloudAgentOAuth,
} = oauthModule;
const { cloudAgentRoutes } = routesModule;

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

// —— Settings store ——

test("cloud agent settings default shape", async () => {
  const settings = await getCloudAgentSettings();
  assert.equal(settings.schemaVersion, 1);
  assert.equal(settings.defaults.backendId, "cesium-agent");
  assert.equal(settings.defaults.executionMode, "isolated");
  assert.equal(settings.defaults.autoDispatch, false);
  assert.deepEqual(settings.routingRules, []);
  assert.deepEqual(settings.connections, []);
});

test("connection upsert stores token and public view redacts it", async () => {
  await upsertCloudAgentConnection({
    providerId: "github",
    method: "token",
    accessToken: "ghp_secrettoken1234",
    webhookSecret: "whsec-1",
    accountLabel: "@octocat",
    scopes: ["repo"],
  });

  const connection = await getCloudAgentConnection("github");
  assert.equal(connection?.accessToken, "ghp_secrettoken1234");
  assert.equal(connection?.webhookSecret, "whsec-1");

  const publicSettings = await getCloudAgentSettingsPublic();
  const publicConnection = publicSettings.connections.find(
    (entry) => entry.providerId === "github"
  );
  assert.ok(publicConnection);
  assert.equal(publicConnection.tokenLastFour, "1234");
  assert.equal(publicConnection.webhookSecretConfigured, true);
  assert.equal(publicConnection.accountLabel, "@octocat");
  assert.ok(!("accessToken" in publicConnection));
  assert.ok(!("webhookSecret" in publicConnection));
});

test("oauth app upsert redacts client secret in public view", async () => {
  await upsertCloudAgentOAuthApp({
    providerId: "linear",
    clientId: "client-abc",
    clientSecret: "very-secret",
  });
  const publicSettings = await getCloudAgentSettingsPublic();
  const app = publicSettings.oauthApps.find((entry) => entry.providerId === "linear");
  assert.ok(app);
  assert.equal(app.clientId, "client-abc");
  assert.equal(app.clientSecretConfigured, true);
  assert.ok(!("clientSecret" in app));
});

test("patch settings updates defaults and routing rules", async () => {
  const patched = await patchCloudAgentSettings({
    defaults: { autoDispatch: true, modelId: "glm-5.2", executionMode: "local" },
    routingRules: [
      {
        id: "r1",
        providerId: "github",
        match: "owner/repo",
        workspaceId: "ws-1",
        backendId: "cesium-agent",
      },
    ],
  });
  assert.equal(patched.defaults.autoDispatch, true);
  assert.equal(patched.defaults.modelId, "glm-5.2");
  assert.equal(patched.defaults.executionMode, "local");
  assert.equal(patched.routingRules.length, 1);
  assert.equal(patched.routingRules[0]?.match, "owner/repo");

  // Restore for later tests.
  await patchCloudAgentSettings({
    defaults: { autoDispatch: false, modelId: null, executionMode: "isolated" },
    routingRules: [],
  });
});

test("disconnect removes the stored connection", async () => {
  await upsertCloudAgentConnection({
    providerId: "slack",
    method: "token",
    accessToken: "xoxb-slack-token",
  });
  assert.ok(await getCloudAgentConnection("slack"));
  await deleteCloudAgentConnection("slack");
  assert.equal(await getCloudAgentConnection("slack"), null);
});

// —— Webhook signature verification ——

test("github signature verification", () => {
  const body = JSON.stringify({ hello: "world" });
  const secret = "gh-secret";
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGithubSignature(body, good, secret), true);
  assert.equal(verifyGithubSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyGithubSignature(body, undefined, secret), false);
});

test("linear signature verification", () => {
  const body = JSON.stringify({ action: "create" });
  const secret = "linear-secret";
  const good = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyLinearSignature(body, good, secret), true);
  assert.equal(verifyLinearSignature(body, "bad", secret), false);
});

test("slack signature verification honors timestamp tolerance", () => {
  const body = "payload=1";
  const secret = "slack-secret";
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  const good = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  assert.equal(verifySlackSignature(body, good, timestamp, secret, nowMs), true);
  assert.equal(verifySlackSignature(body, good, timestamp, "other", nowMs), false);
  const staleTimestamp = String(Math.floor(nowMs / 1000) - 3600);
  const stale = `v0=${createHmac("sha256", secret)
    .update(`v0:${staleTimestamp}:${body}`)
    .digest("hex")}`;
  assert.equal(verifySlackSignature(body, stale, staleTimestamp, secret, nowMs), false);
});

// —— Webhook parsing ——

test("github issues assigned webhook becomes an assignment", () => {
  const payload = {
    action: "assigned",
    issue: {
      number: 42,
      title: "Fix the flux capacitor",
      body: "It drifts.",
      html_url: "https://github.com/owner/repo/issues/42",
      labels: [{ name: "bug" }],
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "octocat" },
  };
  const rawBody = JSON.stringify(payload);
  const secret = "gh-secret";
  const result = processCloudAgentWebhook({
    providerId: "github",
    rawBody,
    headers: {
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
    webhookSecret: secret,
  });
  assert.equal(result.kind, "assignment");
  if (result.kind === "assignment") {
    assert.equal(result.assignment.title, "Fix the flux capacitor");
    assert.equal(result.assignment.source.repo, "owner/repo");
    assert.equal(result.assignment.source.externalId, "42");
    assert.equal(result.assignment.verified, true);
  }
});

test("github webhook with bad signature is rejected", () => {
  const rawBody = JSON.stringify({ action: "assigned" });
  const result = processCloudAgentWebhook({
    providerId: "github",
    rawBody,
    headers: {
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=0000",
    },
    webhookSecret: "gh-secret",
  });
  assert.equal(result.kind, "rejected");
});

test("github webhook without stored secret is accepted but unverified", () => {
  const payload = {
    action: "assigned",
    issue: { number: 1, title: "T", body: "" },
    repository: { full_name: "owner/repo" },
  };
  const result = processCloudAgentWebhook({
    providerId: "github",
    rawBody: JSON.stringify(payload),
    headers: { "x-github-event": "issues" },
    webhookSecret: null,
  });
  assert.equal(result.kind, "assignment");
  if (result.kind === "assignment") {
    assert.equal(result.assignment.verified, false);
  }
});

test("linear issue assignment webhook becomes an assignment", () => {
  const payload = {
    action: "update",
    type: "Issue",
    url: "https://linear.app/team/issue/OSP-67",
    updatedFrom: { assigneeId: null },
    data: {
      id: "issue-uuid-1",
      identifier: "OSP-67",
      title: "Cloud Agents integration",
      description: "Do the thing.",
      assignee: { id: "user-1", name: "Agent Smith" },
      team: { key: "OSP" },
      project: { name: "Integrations" },
      labels: [{ name: "agent" }],
    },
  };
  const result = processCloudAgentWebhook({
    providerId: "linear",
    rawBody: JSON.stringify(payload),
    headers: {},
    webhookSecret: null,
  });
  assert.equal(result.kind, "assignment");
  if (result.kind === "assignment") {
    assert.equal(result.assignment.title, "OSP-67: Cloud Agents integration");
    assert.equal(result.assignment.source.teamKey, "OSP");
    assert.equal(result.assignment.source.externalId, "issue-uuid-1");
  }
});

test("linear issue update without assignee change is ignored", () => {
  const payload = {
    action: "update",
    type: "Issue",
    updatedFrom: { title: "old" },
    data: {
      id: "issue-uuid-2",
      title: "Renamed",
      assignee: { id: "user-1" },
    },
  };
  const result = processCloudAgentWebhook({
    providerId: "linear",
    rawBody: JSON.stringify(payload),
    headers: {},
    webhookSecret: null,
  });
  assert.equal(result.kind, "ignored");
});

test("slack url_verification challenge is echoed", () => {
  const result = processCloudAgentWebhook({
    providerId: "slack",
    rawBody: JSON.stringify({ type: "url_verification", challenge: "chal-123" }),
    headers: {},
    webhookSecret: null,
  });
  assert.equal(result.kind, "challenge");
  if (result.kind === "challenge") {
    assert.equal(result.challenge, "chal-123");
  }
});

test("slack app_mention becomes an assignment with mention stripped", () => {
  const payload = {
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "<@U123BOT> please refactor the auth module",
      channel: "C0LOUDAG",
      ts: "1712345678.000100",
      user: "U777",
    },
  };
  const result = processCloudAgentWebhook({
    providerId: "slack",
    rawBody: JSON.stringify(payload),
    headers: {},
    webhookSecret: null,
  });
  assert.equal(result.kind, "assignment");
  if (result.kind === "assignment") {
    assert.equal(result.assignment.body, "please refactor the auth module");
    assert.equal(result.assignment.source.channel, "C0LOUDAG");
    assert.equal(result.assignment.source.externalId, "1712345678.000100");
  }
});

test("invalid webhook JSON is rejected", () => {
  const result = processCloudAgentWebhook({
    providerId: "github",
    rawBody: "not-json{",
    headers: {},
    webhookSecret: null,
  });
  assert.equal(result.kind, "rejected");
});

// —— Routing ——

test("routing rules filter assignments to the right workspace", async () => {
  await patchCloudAgentSettings({
    defaults: { workspaceId: "ws-default" },
    routingRules: [
      {
        id: "rule-linear",
        providerId: "linear",
        match: "osp",
        workspaceId: "ws-linear",
        backendId: "cesium-agent",
        modelId: "glm-5.2",
        executionMode: "local",
      },
      {
        id: "rule-repo",
        providerId: "github",
        match: "owner/repo",
        workspaceId: "ws-github",
      },
    ],
  });

  const linearRoute = await resolveCloudAgentRoute({
    providerId: "linear",
    teamKey: "OSP",
  });
  assert.equal(linearRoute.workspaceId, "ws-linear");
  assert.equal(linearRoute.modelId, "glm-5.2");
  assert.equal(linearRoute.executionMode, "local");
  assert.equal(linearRoute.matchedRuleId, "rule-linear");

  const githubRoute = await resolveCloudAgentRoute({
    providerId: "github",
    repo: "owner/repo",
  });
  assert.equal(githubRoute.workspaceId, "ws-github");

  const fallbackRoute = await resolveCloudAgentRoute({
    providerId: "slack",
    channel: "C0OTHER",
  });
  assert.equal(fallbackRoute.workspaceId, "ws-default");
  assert.equal(fallbackRoute.matchedRuleId, null);

  await patchCloudAgentSettings({ defaults: { workspaceId: null }, routingRules: [] });
});

// —— Task store ——

test("task store lifecycle: create, update, timeline, find by conversation, delete", async () => {
  const task = await createCloudAgentTask({
    title: "Try the harness",
    prompt: "Do things.",
    status: "inbox",
    source: { providerId: "manual" },
    workspaceId: "ws-x",
    conversationId: null,
    backendId: "cesium-agent",
    modelId: null,
    executionMode: "isolated",
  });
  assert.equal(task.status, "inbox");

  const updated = await updateCloudAgentTask(task.id, {
    status: "running",
    conversationId: "conv-1",
  });
  assert.equal(updated.status, "running");

  const withTimeline = await appendCloudAgentTaskTimeline(task.id, {
    kind: "dispatched",
    message: "Dispatched for test.",
  });
  assert.equal(withTimeline.timeline.length, 1);

  const byConversation = await findCloudAgentTaskByConversation("conv-1");
  assert.equal(byConversation?.id, task.id);

  const listed = await listCloudAgentTasks({ workspaceId: "ws-x" });
  assert.ok(listed.some((entry) => entry.id === task.id));

  await deleteCloudAgentTask(task.id);
  assert.equal(await getCloudAgentTask(task.id), null);
});

// —— Dispatcher helpers ——

test("branch names are slugified and unique per task", () => {
  const branch = buildCloudAgentBranchName({
    id: "abcd1234-ef56-7890",
    title: "Fix: The Flux Capacitor! (urgent)",
  });
  assert.match(branch, /^cloud\/fix-the-flux-capacitor-urgent-abcd1234$/);
});

test("task prompt includes source, contract, and artifacts guidance", async () => {
  const task = await createCloudAgentTask({
    title: "Add dark mode",
    prompt: "Users want a dark theme toggle.",
    status: "inbox",
    source: {
      providerId: "linear",
      teamKey: "OSP",
      url: "https://linear.app/x/issue/OSP-67",
      sender: "PM",
    },
    workspaceId: null,
    conversationId: null,
    backendId: null,
    modelId: null,
    executionMode: "isolated",
  });
  const prompt = buildCloudAgentTaskPrompt(task, {
    branch: "cloud/add-dark-mode-123",
    artifactsDir: ".cesium/cloud-artifacts/task-1",
  });
  assert.match(prompt, /# Task: Add dark mode/);
  assert.match(prompt, /Linear team: OSP/);
  assert.match(prompt, /cloud\/add-dark-mode-123/);
  assert.match(prompt, /\.cesium\/cloud-artifacts\/task-1/);
  assert.match(prompt, /steer you with follow-up messages/);

  const localPrompt = buildCloudAgentTaskPrompt(task, {
    branch: null,
    artifactsDir: ".cesium/cloud-artifacts/task-1",
  });
  assert.match(localPrompt, /"local" mode/);
  await deleteCloudAgentTask(task.id);
});

test("dispatch fails cleanly without a target workspace", async () => {
  const task = await createCloudAgentTask({
    title: "No workspace",
    prompt: "",
    status: "inbox",
    source: { providerId: "manual" },
    workspaceId: null,
    conversationId: null,
    backendId: null,
    modelId: null,
    executionMode: "local",
  });
  await assert.rejects(
    () => dispatchCloudAgentTask(task.id, {}),
    /No target workspace/
  );
  // Early validation failures leave the task in the inbox so it can be
  // re-dispatched once routing/defaults are fixed.
  const stillInbox = await getCloudAgentTask(task.id);
  assert.equal(stillInbox?.status, "inbox");
  await deleteCloudAgentTask(task.id);
});

// —— OAuth ——

test("authorize URLs are provider-specific", () => {
  const linearUrl = buildCloudAgentAuthorizeUrl({
    providerId: "linear",
    clientId: "cid",
    redirectUri: "https://app.example.com/api/cloud-agents/oauth/callback",
    state: "st",
  });
  assert.match(linearUrl, /^https:\/\/linear\.app\/oauth\/authorize\?/);
  assert.match(linearUrl, /actor=app/);

  const githubUrl = buildCloudAgentAuthorizeUrl({
    providerId: "github",
    clientId: "cid",
    redirectUri: "https://app.example.com/cb",
    state: "st",
  });
  assert.match(githubUrl, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);

  const slackUrl = buildCloudAgentAuthorizeUrl({
    providerId: "slack",
    clientId: "cid",
    redirectUri: "https://app.example.com/cb",
    state: "st",
  });
  assert.match(slackUrl, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
});

test("oauth start requires stored app credentials", async () => {
  await assert.rejects(
    () => startCloudAgentOAuth({ providerId: "slack", publicOrigin: "http://localhost:9100" }),
    /OAuth client id and secret/
  );
});

test("oauth helper URLs and success page", () => {
  assert.equal(
    buildCloudAgentOAuthCallbackUrl("http://localhost:9100/"),
    "http://localhost:9100/api/cloud-agents/oauth/callback"
  );
  assert.equal(
    buildCloudAgentWebhookUrl("http://localhost:9100", "linear"),
    "http://localhost:9100/api/cloud-agents/webhooks/linear"
  );
  assert.match(cloudAgentOAuthSuccessHtml("Linear"), /opencursor-cloud-agents-oauth/);
});

// —— Routes ——

test("settings route returns public settings and endpoint URLs", async () => {
  const response = await cloudAgentRoutes.request("/api/cloud-agents/settings", {
    method: "GET",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    settings: { schemaVersion: number };
    endpoints: { webhooks: Record<string, string> };
  };
  assert.equal(body.settings.schemaVersion, 1);
  assert.match(body.endpoints.webhooks.github, /\/api\/cloud-agents\/webhooks\/github$/);
});

test("slack webhook route answers url_verification challenge", async () => {
  const response = await cloudAgentRoutes.request("/api/cloud-agents/webhooks/slack", {
    method: "POST",
    body: JSON.stringify({ type: "url_verification", challenge: "route-chal" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { challenge: string };
  assert.equal(body.challenge, "route-chal");
});

test("github webhook route creates an inbox task", async () => {
  // Earlier tests may have stored a github connection with a webhook secret;
  // this test exercises the unsigned (no stored secret) path.
  await deleteCloudAgentConnection("github");
  const payload = {
    action: "assigned",
    issue: {
      number: 7,
      title: "Route test issue",
      body: "Body",
      html_url: "https://github.com/owner/repo/issues/7",
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "octocat" },
  };
  const response = await cloudAgentRoutes.request("/api/cloud-agents/webhooks/github", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", "x-github-event": "issues" },
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { ok: boolean; taskId: string; dispatched: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.dispatched, false);
  const task = await getCloudAgentTask(body.taskId);
  assert.equal(task?.title, "Route test issue");
  assert.equal(task?.unverified, true);
  await deleteCloudAgentTask(body.taskId);
});

test("github webhook route rejects tampered signatures", async () => {
  await upsertCloudAgentConnection({
    providerId: "github",
    method: "token",
    accessToken: "ghp_secrettoken1234",
    webhookSecret: "route-secret",
  });
  const response = await cloudAgentRoutes.request("/api/cloud-agents/webhooks/github", {
    method: "POST",
    body: JSON.stringify({ action: "assigned" }),
    headers: {
      "Content-Type": "application/json",
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=forged",
    },
  });
  assert.equal(response.status, 401);
  await deleteCloudAgentConnection("github");
});

test("manual task route creates and deletes tasks", async () => {
  const createResponse = await cloudAgentRoutes.request("/api/cloud-agents/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Manual route task", prompt: "hi" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as { task: { id: string; status: string } };
  assert.equal(created.task.status, "inbox");

  const listResponse = await cloudAgentRoutes.request("/api/cloud-agents/tasks", {
    method: "GET",
  });
  const listed = (await listResponse.json()) as { tasks: Array<{ id: string }> };
  assert.ok(listed.tasks.some((task) => task.id === created.task.id));

  const deleteResponse = await cloudAgentRoutes.request(
    `/api/cloud-agents/tasks/${created.task.id}`,
    { method: "DELETE" }
  );
  assert.equal(deleteResponse.status, 200);
});
