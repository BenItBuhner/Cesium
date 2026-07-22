import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-cloud-agents-integrations-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [settingsModule, oauthModule, connectionsModule, attachmentsModule, webhooksModule, dispatcherModule, tasksModule] =
  await Promise.all([
    import("../src/lib/cloud-agents/settings.js"),
    import("../src/lib/cloud-agents/oauth.js"),
    import("../src/lib/cloud-agents/connections.js"),
    import("../src/lib/cloud-agents/attachments.js"),
    import("../src/lib/cloud-agents/webhooks.js"),
    import("../src/lib/cloud-agents/dispatcher.js"),
    import("../src/lib/cloud-agents/tasks.js"),
  ]);

const {
  deleteCloudAgentConnection,
  getCloudAgentConnection,
  upsertCloudAgentConnection,
  upsertCloudAgentOAuthApp,
} = settingsModule;
const { completeCloudAgentOAuthCallback, startCloudAgentOAuth } = oauthModule;
const { postCloudAgentUpdate, verifyCloudAgentToken } = connectionsModule;
const {
  attachmentAuthHeaders,
  extractMarkdownMediaRefs,
  fetchCloudAgentAttachments,
  normalizeSlackMrkdwn,
  CLOUD_AGENT_MAX_ATTACHMENT_BYTES,
} = attachmentsModule;
const { processCloudAgentWebhook } = webhooksModule;
const { ingestCloudAgentAssignment } = dispatcherModule;
const { deleteCloudAgentTask, listCloudAgentTasks } = tasksModule;

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

type FetchCall = { url: string; init?: RequestInit };

/** Installs a scripted global fetch; returns recorded calls and a restore fn. */
function mockGlobalFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function extractState(authUrl: string): string {
  return new URL(authUrl).searchParams.get("state")!;
}

// —— OAuth end-to-end (token exchange + identity + storage) ——

test("linear OAuth callback exchanges the code and stores the connection", async () => {
  await upsertCloudAgentOAuthApp({
    providerId: "linear",
    clientId: "lin-client",
    clientSecret: "lin-secret",
  });
  const { authUrl } = await startCloudAgentOAuth({
    providerId: "linear",
    publicOrigin: "http://localhost:9100",
  });
  const state = extractState(authUrl);

  const mock = mockGlobalFetch((url) => {
    if (url === "https://api.linear.app/oauth/token") {
      return jsonResponse({ access_token: "lin_oauth_tok_1234", scope: "read,write" });
    }
    if (url === "https://api.linear.app/graphql") {
      return jsonResponse({
        data: { viewer: { id: "u1", name: "Ada" }, organization: { name: "Acme" } },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const result = await completeCloudAgentOAuthCallback({ code: "code-1", state });
    assert.equal(result.providerId, "linear");

    const exchange = mock.calls.find((call) => call.url.includes("oauth/token"));
    assert.ok(exchange);
    const form = new URLSearchParams(String(exchange.init?.body));
    assert.equal(form.get("client_id"), "lin-client");
    assert.equal(form.get("client_secret"), "lin-secret");
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(
      form.get("redirect_uri"),
      "http://localhost:9100/api/cloud-agents/oauth/callback"
    );

    const connection = await getCloudAgentConnection("linear");
    assert.equal(connection?.method, "oauth");
    assert.equal(connection?.accessToken, "lin_oauth_tok_1234");
    assert.equal(connection?.accountLabel, "Ada · Acme");
    assert.deepEqual(connection?.scopes, ["read", "write"]);
  } finally {
    mock.restore();
    await deleteCloudAgentConnection("linear");
  }
});

test("github OAuth callback exchanges the code and verifies the user", async () => {
  await upsertCloudAgentOAuthApp({
    providerId: "github",
    clientId: "gh-client",
    clientSecret: "gh-secret",
  });
  const { authUrl } = await startCloudAgentOAuth({
    providerId: "github",
    publicOrigin: "http://localhost:9100",
  });
  const state = extractState(authUrl);

  const mock = mockGlobalFetch((url) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return jsonResponse({ access_token: "gho_tok_9999", scope: "repo,read:user" });
    }
    if (url === "https://api.github.com/user") {
      return jsonResponse({ login: "octocat" }, 200, { "x-oauth-scopes": "repo, read:user" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const result = await completeCloudAgentOAuthCallback({ code: "code-2", state });
    assert.equal(result.providerId, "github");
    const connection = await getCloudAgentConnection("github");
    assert.equal(connection?.method, "oauth");
    assert.equal(connection?.accountLabel, "@octocat");
  } finally {
    mock.restore();
    await deleteCloudAgentConnection("github");
  }
});

test("slack OAuth callback uses oauth.v2.access and stores the bot token", async () => {
  await upsertCloudAgentOAuthApp({
    providerId: "slack",
    clientId: "sl-client",
    clientSecret: "sl-secret",
  });
  const { authUrl } = await startCloudAgentOAuth({
    providerId: "slack",
    publicOrigin: "http://localhost:9100",
  });
  const state = extractState(authUrl);

  const mock = mockGlobalFetch((url) => {
    if (url === "https://slack.com/api/oauth.v2.access") {
      return jsonResponse({
        ok: true,
        access_token: "xoxb-slack-777",
        scope: "chat:write,app_mentions:read",
        team: { name: "Acme Workspace" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const result = await completeCloudAgentOAuthCallback({ code: "code-3", state });
    assert.equal(result.providerId, "slack");
    const connection = await getCloudAgentConnection("slack");
    assert.equal(connection?.accessToken, "xoxb-slack-777");
    assert.equal(connection?.accountLabel, "Acme Workspace");
  } finally {
    mock.restore();
    await deleteCloudAgentConnection("slack");
  }
});

test("OAuth callback rejects unknown or replayed state", async () => {
  await assert.rejects(
    () => completeCloudAgentOAuthCallback({ code: "c", state: "bogus-state" }),
    /invalid or expired/
  );
});

// —— Token verification ——

test("verifyCloudAgentToken covers all providers and the GitHub App fallback", async () => {
  const mock = mockGlobalFetch((url, init) => {
    if (url === "https://api.github.com/user") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes("ghs_installation")) {
        return jsonResponse({ message: "Resource not accessible by integration" }, 403);
      }
      return jsonResponse({ login: "octocat" }, 200, { "x-oauth-scopes": "repo" });
    }
    if (url.startsWith("https://api.github.com/installation/repositories")) {
      return jsonResponse({
        total_count: 3,
        repositories: [{ owner: { login: "acme" } }],
      });
    }
    if (url === "https://api.linear.app/graphql") {
      return jsonResponse({
        data: { viewer: { id: "u", name: "Ada" }, organization: { name: "Acme" } },
      });
    }
    if (url === "https://slack.com/api/auth.test") {
      return jsonResponse({ ok: true, team: "Acme", user: "botuser" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    assert.equal((await verifyCloudAgentToken("github", "ghp_user")).accountLabel, "@octocat");
    assert.equal(
      (await verifyCloudAgentToken("github", "ghs_installation")).accountLabel,
      "GitHub App · acme (3 repos)"
    );
    assert.equal(
      (await verifyCloudAgentToken("linear", "lin_api_key")).accountLabel,
      "Ada · Acme"
    );
    assert.equal(
      (await verifyCloudAgentToken("slack", "xoxb-1")).accountLabel,
      "botuser · Acme"
    );
  } finally {
    mock.restore();
  }
});

test("verifyCloudAgentToken surfaces provider rejections", async () => {
  const mock = mockGlobalFetch(() => jsonResponse({ ok: false, error: "invalid_auth" }, 200));
  try {
    await assert.rejects(() => verifyCloudAgentToken("slack", "bad"), /invalid_auth/);
  } finally {
    mock.restore();
  }
});

// —— Outbound updates ——

test("postCloudAgentUpdate targets the right provider APIs", async () => {
  await upsertCloudAgentConnection({
    providerId: "github",
    method: "token",
    accessToken: "ghp_x",
  });
  await upsertCloudAgentConnection({
    providerId: "linear",
    method: "token",
    accessToken: "lin_api_x",
  });
  await upsertCloudAgentConnection({
    providerId: "slack",
    method: "token",
    accessToken: "xoxb-x",
  });

  const mock = mockGlobalFetch((url, init) => {
    if (url === "https://api.github.com/repos/owner/repo/issues/5/comments") {
      return jsonResponse({ id: 1 }, 201);
    }
    if (url === "https://api.linear.app/graphql") {
      const body = JSON.parse(String(init?.body)) as { variables?: { input?: { issueId?: string } } };
      assert.equal(body.variables?.input?.issueId, "lin-issue-1");
      return jsonResponse({ data: { commentCreate: { success: true } } });
    }
    if (url === "https://slack.com/api/chat.postMessage") {
      const body = JSON.parse(String(init?.body)) as { channel?: string; thread_ts?: string };
      assert.equal(body.channel, "C0LOUDAG");
      assert.equal(body.thread_ts, "171234.0001");
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const baseTask = {
    schemaVersion: 1 as const,
    id: "t",
    createdAt: 0,
    updatedAt: 0,
    title: "T",
    prompt: "",
    status: "awaiting_review" as const,
    workspaceId: null,
    conversationId: null,
    backendId: null,
    modelId: null,
    executionMode: "local" as const,
    timeline: [],
  };
  try {
    const github = await postCloudAgentUpdate(
      { ...baseTask, source: { providerId: "github", repo: "owner/repo", externalId: "5" } },
      "Update"
    );
    assert.match(github.detail, /owner\/repo#5/);

    const linear = await postCloudAgentUpdate(
      { ...baseTask, source: { providerId: "linear", externalId: "lin-issue-1" } },
      "Update"
    );
    assert.match(linear.detail, /lin-issue-1/);

    const slack = await postCloudAgentUpdate(
      {
        ...baseTask,
        source: { providerId: "slack", channel: "C0LOUDAG", externalId: "171234.0001" },
      },
      "Update"
    );
    assert.match(slack.detail, /C0LOUDAG/);
  } finally {
    mock.restore();
    await deleteCloudAgentConnection("github");
    await deleteCloudAgentConnection("linear");
    await deleteCloudAgentConnection("slack");
  }
});

// —— Markdown media extraction ——

test("extractMarkdownMediaRefs finds markdown, HTML, and bare attachment URLs", () => {
  const body = [
    "Here is a bug:",
    "![screenshot](https://user-images.githubusercontent.com/1/shot.png)",
    '<img src="https://example.com/inline.jpeg" alt="x">',
    '<video src="https://example.com/demo.mp4"></video>',
    "https://github.com/user-attachments/assets/abc-def",
    "https://uploads.linear.app/xyz/clip.mov",
    "and a normal link: [docs](https://example.com/docs)",
  ].join("\n");
  const refs = extractMarkdownMediaRefs(body);
  const urls = refs.map((ref) => ref.url);
  assert.deepEqual(urls, [
    "https://user-images.githubusercontent.com/1/shot.png",
    "https://example.com/inline.jpeg",
    "https://example.com/demo.mp4",
    "https://github.com/user-attachments/assets/abc-def",
    "https://uploads.linear.app/xyz/clip.mov",
  ]);
  assert.equal(refs[0]?.name, "screenshot");
  assert.equal(refs[0]?.mimeType, "image/png");
  assert.equal(refs[2]?.mimeType, "video/mp4");
  assert.equal(refs[4]?.mimeType, "video/quicktime");
});

test("extractMarkdownMediaRefs dedupes repeated urls", () => {
  const body =
    "![a](https://example.com/x.png) and again ![b](https://example.com/x.png)";
  assert.equal(extractMarkdownMediaRefs(body).length, 1);
});

// —— Slack mrkdwn ——

test("normalizeSlackMrkdwn converts links, entities, and emphasis", () => {
  const input =
    "please *fix* the <https://example.com/page|landing page> and ~drop~ the old one, see <https://example.com/raw> &amp; ping <@U123>";
  const output = normalizeSlackMrkdwn(input);
  assert.match(output, /\*\*fix\*\*/);
  assert.match(output, /\[landing page\]\(https:\/\/example\.com\/page\)/);
  assert.match(output, /~~drop~~/);
  assert.match(output, /see https:\/\/example\.com\/raw/);
  assert.match(output, /& ping @U123/);
});

// —— Attachment auth + download ——

test("attachmentAuthHeaders picks provider-appropriate auth", () => {
  assert.deepEqual(
    attachmentAuthHeaders("https://files.slack.com/f/1.png", "slack", "xoxb-1"),
    { Authorization: "Bearer xoxb-1" }
  );
  assert.deepEqual(
    attachmentAuthHeaders("https://uploads.linear.app/a/b.png", "linear", "lin_api_key"),
    { Authorization: "lin_api_key" }
  );
  assert.deepEqual(
    attachmentAuthHeaders("https://uploads.linear.app/a/b.png", "linear", "lin_oauth_tok"),
    { Authorization: "Bearer lin_oauth_tok" }
  );
  assert.deepEqual(
    attachmentAuthHeaders("https://user-images.githubusercontent.com/1/s.png", "github", "ghp_1"),
    { Authorization: "Bearer ghp_1" }
  );
  // Foreign hosts never receive the provider token.
  assert.deepEqual(
    attachmentAuthHeaders("https://evil.example.com/x.png", "slack", "xoxb-1"),
    {}
  );
});

test("fetchCloudAgentAttachments downloads media, skips non-media and oversized files", async () => {
  const png = Buffer.from("png-bytes");
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("ok.png")) {
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("page.html")) {
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.endsWith("huge.png")) {
      return new Response(Buffer.alloc(CLOUD_AGENT_MAX_ATTACHMENT_BYTES + 1), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const result = await fetchCloudAgentAttachments(
    [
      { url: "https://example.com/ok.png" },
      { url: "https://example.com/page.html" },
      { url: "https://example.com/huge.png" },
      { url: "https://example.com/missing.png" },
    ],
    "manual",
    { fetchImpl }
  );
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.mimeType, "image/png");
  assert.equal(result.attachments[0]?.name, "ok.png");
  assert.equal(
    Buffer.from(result.attachments[0]!.data, "base64").toString(),
    "png-bytes"
  );
  assert.equal(result.notes.length, 3);
});

test("fetchCloudAgentAttachments retries anonymously when auth breaks public CDNs", async () => {
  await upsertCloudAgentConnection({
    providerId: "github",
    method: "token",
    accessToken: "ghs_installation_token",
  });
  const attempts: Array<{ url: string; hasAuth: boolean }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hasAuth = Boolean(new Headers(init?.headers).get("authorization"));
    attempts.push({ url, hasAuth });
    // Public raw content 404s when an unexpected Authorization header is sent.
    if (hasAuth) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Buffer.from("img"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;

  try {
    const result = await fetchCloudAgentAttachments(
      [{ url: "https://raw.githubusercontent.com/o/r/main/logo.png" }],
      "github",
      { fetchImpl }
    );
    assert.equal(result.attachments.length, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.hasAuth, true);
    assert.equal(attempts[1]?.hasAuth, false);
  } finally {
    await deleteCloudAgentConnection("github");
  }
});

// —— Webhook media plumbing ——

test("github issue webhook carries media refs into the assignment", () => {
  const payload = {
    action: "assigned",
    issue: {
      number: 3,
      title: "Broken layout",
      body: "See ![shot](https://user-images.githubusercontent.com/1/broken.png)",
      html_url: "https://github.com/o/r/issues/3",
    },
    repository: { full_name: "o/r" },
  };
  const result = processCloudAgentWebhook({
    providerId: "github",
    rawBody: JSON.stringify(payload),
    headers: { "x-github-event": "issues" },
    webhookSecret: null,
  });
  assert.equal(result.kind, "assignment");
  if (result.kind === "assignment") {
    assert.equal(result.assignment.mediaRefs?.length, 1);
    assert.equal(
      result.assignment.mediaRefs?.[0]?.url,
      "https://user-images.githubusercontent.com/1/broken.png"
    );
  }
});

test("slack app_mention with files extracts media refs and normalizes mrkdwn", () => {
  const payload = {
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "<@U1BOT> check the <https://example.com/spec|spec> and this clip",
      channel: "C1",
      ts: "1.0",
      user: "U777",
      files: [
        {
          name: "clip.mp4",
          mimetype: "video/mp4",
          url_private_download: "https://files.slack.com/f/clip.mp4",
        },
      ],
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
    assert.match(result.assignment.body, /\[spec\]\(https:\/\/example\.com\/spec\)/);
    assert.equal(result.assignment.mediaRefs?.[0]?.mimeType, "video/mp4");
    assert.equal(result.assignment.followUpOnly, undefined);
  }
});

test("slack thread replies are follow-up only", () => {
  const payload = {
    type: "event_callback",
    event: {
      type: "message",
      text: "any update?",
      channel: "C1",
      ts: "2.0",
      thread_ts: "1.0",
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
    assert.equal(result.assignment.followUpOnly, true);
    assert.equal(result.assignment.source.externalId, "1.0");
  }
});

test("linear comment webhook is follow-up only and ignored without an active task", async () => {
  const payload = {
    action: "create",
    type: "Comment",
    url: "https://linear.app/x/comment/1",
    data: {
      id: "comment-1",
      body: "Please also update the docs ![ref](https://uploads.linear.app/a/ref.png)",
      issue: { id: "issue-untracked-1", identifier: "OSP-99" },
      user: { name: "Ada" },
    },
  };
  const parsed = processCloudAgentWebhook({
    providerId: "linear",
    rawBody: JSON.stringify(payload),
    headers: {},
    webhookSecret: null,
  });
  assert.equal(parsed.kind, "assignment");
  if (parsed.kind !== "assignment") {
    return;
  }
  assert.equal(parsed.assignment.followUpOnly, true);
  assert.equal(parsed.assignment.mediaRefs?.length, 1);

  const before = (await listCloudAgentTasks()).length;
  const { task, ignoredReason } = await ingestCloudAgentAssignment(parsed.assignment);
  assert.equal(task, null);
  assert.match(ignoredReason ?? "", /active Cloud Agent task/);
  assert.equal((await listCloudAgentTasks()).length, before);
});

test("media refs are stored on newly created tasks", async () => {
  const { task } = await ingestCloudAgentAssignment({
    providerId: "github",
    title: "With media",
    body: "x",
    source: { providerId: "github", repo: "o/r", externalId: "77" },
    verified: true,
    mediaRefs: [{ url: "https://example.com/x.png", mimeType: "image/png" }],
  });
  assert.ok(task);
  assert.equal(task!.attachments?.length, 1);
  await deleteCloudAgentTask(task!.id);
});
