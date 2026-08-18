import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-oauth-title-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.CESIUM_BASE_URL;
delete process.env.CESIUM_API_KEY;
delete process.env.CESIUM_DEFAULT_MODEL;
delete process.env.OPENCURSOR_TRANSCRIPTION_BASE_URL;
delete process.env.OPENCURSOR_TRANSCRIPTION_API_KEY;
delete process.env.OPENCURSOR_TITLE_MODEL;
delete process.env.GROQ_API_KEY;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  { parseGrokDeviceAuthOutput },
  {
    getCesiumAgentSettings,
    getCesiumAgentSettingsPublic,
    patchCesiumAgentSettings,
    upsertCesiumProviderKey,
  },
  { getCesiumOAuthCatalogEntries, resolveCesiumOAuthRequestAuth },
  { generateTitleFromText, setTitleModelIdOverrideForTests },
] = await Promise.all([
  import("../src/lib/grok-build-login.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/cesium-oauth.js"),
  import("../src/lib/agents/title-generator.js"),
]);

test("parseGrokDeviceAuthOutput extracts labeled verification URL and code", () => {
  const parsed = parseGrokDeviceAuthOutput(
    "Visit https://accounts.x.ai/device to sign in.\nYour code: ABCD-EFGH\n"
  );
  assert.equal(parsed.verificationUrl, "https://accounts.x.ai/device");
  assert.equal(parsed.userCode, "ABCD-EFGH");
});

test("parseGrokDeviceAuthOutput handles ANSI styling and standalone grouped codes", () => {
  const parsed = parseGrokDeviceAuthOutput(
    "\u001b[1mSign in\u001b[0m at \u001b[4mhttps://x.ai/verify?device=1\u001b[0m\n\n  WXYZ-1234\n"
  );
  assert.equal(parsed.verificationUrl, "https://x.ai/verify?device=1");
  assert.equal(parsed.userCode, "WXYZ-1234");
});

test("parseGrokDeviceAuthOutput returns nothing for unrelated output", () => {
  const parsed = parseGrokDeviceAuthOutput("Loading model catalog...\nDone.\n");
  assert.equal(parsed.verificationUrl, undefined);
  assert.equal(parsed.userCode, undefined);
});

test("titleGeneration settings default to null and persist through patches", async () => {
  const initial = await getCesiumAgentSettings();
  assert.equal(initial.titleGeneration.modelId, null);

  await patchCesiumAgentSettings({
    titleGeneration: { modelId: "techlit/kimi-k3" },
  });
  const updated = await getCesiumAgentSettings();
  assert.equal(updated.titleGeneration.modelId, "techlit/kimi-k3");

  // Unrelated patches must not clobber the selection.
  await patchCesiumAgentSettings({ defaultModelId: "openai/gpt-4o-mini" });
  const afterUnrelated = await getCesiumAgentSettings();
  assert.equal(afterUnrelated.titleGeneration.modelId, "techlit/kimi-k3");

  await patchCesiumAgentSettings({ titleGeneration: { modelId: null } });
  const cleared = await getCesiumAgentSettings();
  assert.equal(cleared.titleGeneration.modelId, null);
});

test("public settings expose OAuth provider statuses for the settings UI", async () => {
  const publicSettings = await getCesiumAgentSettingsPublic();
  assert.ok(Array.isArray(publicSettings.oauthProviders));
  const ids = publicSettings.oauthProviders.map((provider) => provider.id);
  // Official subscription logins only: ChatGPT/Codex and SpaceXAI SuperGrok.
  for (const expected of ["openai-codex", "xai"]) {
    assert.ok(ids.includes(expected), `expected ${expected} in ${ids.join(", ")}`);
  }
  for (const blocked of ["anthropic", "github-copilot", "google-antigravity", "google-gemini-cli"]) {
    assert.equal(ids.includes(blocked), false, `blocked ${blocked} leaked into ${ids.join(", ")}`);
  }
  for (const provider of publicSettings.oauthProviders) {
    assert.equal(typeof provider.name, "string");
    assert.equal(typeof provider.connected, "boolean");
    assert.equal(typeof provider.modelCount, "number");
  }
});

test("OAuth catalog and request auth are empty when no account is connected", async () => {
  const entries = await getCesiumOAuthCatalogEntries();
  assert.ok(Array.isArray(entries));
  // No auth.json OAuth credentials exist in the test environment.
  assert.equal(entries.length, 0);

  const auth = await resolveCesiumOAuthRequestAuth({
    providerId: "openai-codex",
    modelId: "openai-codex/gpt-5.3-codex",
  });
  assert.equal(auth, null);
});

test("generateTitleFromText uses the configured catalog model end to end", async () => {
  let observedModel: string | null = null;
  let observedAuth: string | null = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body) as { model?: string };
      observedModel = payload.model ?? null;
      observedAuth = req.headers.authorization ?? null;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "Local Title Proxy Works" } }],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    await patchCesiumAgentSettings({
      customProviders: [
        {
          id: "title-proxy",
          name: "Title Proxy",
          apiKind: "openai-chat-completions",
          baseUrl,
          models: [{ id: "title-mini", name: "Title Mini" }],
        },
      ],
    });
    await upsertCesiumProviderKey({
      providerId: "title-proxy",
      label: "Title Proxy",
      apiKind: "openai-chat-completions",
      apiKey: "test-title-key",
      baseUrl,
    });
    await patchCesiumAgentSettings({
      titleGeneration: { modelId: "title-proxy/title-mini" },
    });

    const title = await generateTitleFromText("How do I set up Postgres replication?");
    assert.equal(title, "Local Title Proxy Works");
    assert.equal(observedModel, "title-mini");
    assert.equal(observedAuth, "Bearer test-title-key");
  } finally {
    await patchCesiumAgentSettings({
      customProviders: [],
      titleGeneration: { modelId: null },
    });
    server.close();
  }
});

test("generateTitleFromText accepts slightly-long titles instead of discarding them", async () => {
  // Regression: kimi-k3 returned "SQLite vs Postgres for Local-First Apps"
  // (6 words) and the old 3-5 word validator threw the title away.
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: "SQLite vs Postgres for Local-First Apps" } },
          ],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    await patchCesiumAgentSettings({
      customProviders: [
        {
          id: "title-proxy-long",
          name: "Title Proxy Long",
          apiKind: "openai-chat-completions",
          baseUrl,
          models: [{ id: "title-mini", name: "Title Mini" }],
        },
      ],
    });
    await upsertCesiumProviderKey({
      providerId: "title-proxy-long",
      label: "Title Proxy Long",
      apiKind: "openai-chat-completions",
      apiKey: "test-title-key",
      baseUrl,
    });
    await patchCesiumAgentSettings({
      titleGeneration: { modelId: "title-proxy-long/title-mini" },
    });

    const title = await generateTitleFromText("sqlite or postgres?");
    assert.equal(title, "SQLite vs Postgres for Local-First Apps");
  } finally {
    await patchCesiumAgentSettings({
      customProviders: [],
      titleGeneration: { modelId: null },
    });
    server.close();
  }
});

test("generateTitleFromText returns null when neither settings nor env are usable", async () => {
  setTitleModelIdOverrideForTests("missing-provider/missing-model");
  try {
    const title = await generateTitleFromText("hello world");
    assert.equal(title, null);
  } finally {
    setTitleModelIdOverrideForTests(undefined);
  }
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
});
