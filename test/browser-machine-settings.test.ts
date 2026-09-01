import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EngineRouter } from "../packages/browser-machine/src/http.ts";
import { registerSettingsRoutes } from "../packages/browser-machine/src/routes/settings-routes.ts";
import { registerAgentRoutes } from "../packages/browser-machine/src/routes/agent-routes.ts";
import { SettingsStore } from "../packages/browser-machine/src/stores/settings.ts";
import { WorkspaceStore } from "../packages/browser-machine/src/stores/workspaces.ts";
import { ConversationStore } from "../packages/browser-machine/src/stores/conversations.ts";
import { Vfs } from "../packages/browser-machine/src/vfs.ts";
import {
  BROWSER_SUPPORTED_BACKEND_IDS,
} from "../packages/browser-machine/src/backend-info.ts";
import type { CesiumModelCatalogEntry } from "@cesium/core";

function makeModel(
  providerId: string,
  modelId: string,
  modelName: string
): CesiumModelCatalogEntry {
  return {
    providerId,
    providerName: providerId,
    modelId,
    modelName,
    apiKind: "openai-chat-completions",
    supportsTools: true,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    supportsImages: false,
    contextWindow: 200_000,
  };
}

async function makeEngine(): Promise<{
  router: EngineRouter;
  settings: SettingsStore;
  workspaces: WorkspaceStore;
}> {
  const router = new EngineRouter();
  const settings = new SettingsStore();
  const vfs = new Vfs();
  vfs.mkdir("/workspaces", { recursive: true });
  const workspaces = new WorkspaceStore(vfs);
  const conversations = new ConversationStore();
  await settings.putCesiumAgentSettings({
    defaultModelId: "acme/model-a",
    providers: [
      {
        id: "acme",
        name: "Acme",
        baseUrl: "https://api.acme.test/v1",
        apiKind: "openai-chat-completions",
        apiKey: "sk-test",
        models: [
          makeModel("acme", "model-a", "Model A"),
          makeModel("acme", "model-b", "Model B"),
        ],
      },
    ],
  });
  registerSettingsRoutes(router, { settings });
  registerAgentRoutes(router, {
    vfs,
    workspaces,
    conversations,
    settings,
    runtime: () => {
      throw new Error("runtime not needed in this test");
    },
  });
  return { router, settings, workspaces };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("browser machine settings surface", () => {
  test("only in-page harnesses are advertised (future-proof registry)", async () => {
    assert.deepEqual([...BROWSER_SUPPORTED_BACKEND_IDS], ["cesium-agent"]);
    const { router } = await makeEngine();
    const response = await router.dispatch("/api/agents/backends");
    const payload = await json<{ backends: Array<{ id: string }>; platform: string }>(response);
    assert.equal(payload.platform, "browser");
    assert.deepEqual(
      payload.backends.map((backend) => backend.id),
      [...BROWSER_SUPPORTED_BACKEND_IDS]
    );
  });

  test("mode catalog only lists modes the in-page harness implements", async () => {
    const { router } = await makeEngine();
    const response = await router.dispatch("/api/settings/cesium-agent");
    const payload = await json<{
      settings: {
        modeCatalog: Array<{ id: string }>;
        modes: { enabled: Record<string, boolean> };
      };
    }>(response);
    assert.deepEqual(
      payload.settings.modeCatalog.map((mode) => mode.id),
      ["agent", "plan", "ask"]
    );
    assert.equal(payload.settings.modes.enabled.orchestration, false);
    assert.equal(payload.settings.modes.enabled.goal, false);
    assert.equal(payload.settings.modes.enabled.workflow, false);
  });

  test("PATCH persists model access entries and enforces the 250-char cap", async () => {
    const { router } = await makeEngine();
    const patch = await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modelAccess: {
          entries: {
            "model-b": { enabled: false },
            "model-a": { description: "fast + cheap" },
          },
        },
      }),
    });
    assert.equal(patch.status, 200);
    const after = await json<{
      settings: { modelAccess: { entries: Record<string, { enabled: boolean; description?: string }> } };
    }>(await router.dispatch("/api/settings/cesium-agent"));
    assert.equal(after.settings.modelAccess.entries["model-b"]?.enabled, false);
    assert.equal(after.settings.modelAccess.entries["model-a"]?.description, "fast + cheap");

    const tooLong = await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modelAccess: { entries: { "model-a": { description: "x".repeat(251) } } },
      }),
    });
    assert.equal(tooLong.status, 400);
    const error = await json<{ error: string }>(tooLong);
    assert.match(error.error, /must be at most 250 characters/);

    // Deleting via null restores the implicit default.
    await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({ modelAccess: { entries: { "model-b": null } } }),
    });
    const restored = await json<{
      settings: { modelAccess: { entries: Record<string, unknown> } };
    }>(await router.dispatch("/api/settings/cesium-agent"));
    assert.equal(restored.settings.modelAccess.entries["model-b"], undefined);
  });

  test("PATCH persists modes, tool permissions, and limits; last mode is protected", async () => {
    const { router } = await makeEngine();
    const patch = await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modes: { enabled: { plan: false, ask: false } },
        toolPermissions: { terminal: "deny", editFile: "allow" },
        harness: { limits: { waitMaxSeconds: 45 } },
      }),
    });
    assert.equal(patch.status, 200);
    const after = await json<{
      settings: {
        modes: { enabled: Record<string, boolean> };
        toolPermissions: Record<string, string>;
        harness: { limits: { waitMaxSeconds: number } };
      };
    }>(await router.dispatch("/api/settings/cesium-agent"));
    assert.equal(after.settings.modes.enabled.plan, false);
    assert.equal(after.settings.modes.enabled.ask, false);
    assert.equal(after.settings.modes.enabled.agent, true);
    assert.equal(after.settings.toolPermissions.terminal, "deny");
    assert.equal(after.settings.toolPermissions.editFile, "allow");
    assert.equal(after.settings.harness.limits.waitMaxSeconds, 45);

    const lastMode = await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({ modes: { enabled: { agent: false } } }),
    });
    assert.equal(lastMode.status, 400);
    const error = await json<{ error: string }>(lastMode);
    assert.match(error.error, /At least one Cesium mode/);

    // Restore for the following tests (shared in-memory kv cache).
    await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modes: { enabled: { plan: true, ask: true } },
        toolPermissions: { terminal: "ask", editFile: "ask" },
      }),
    });
  });

  test("model toggles persist via PUT (client contract) and POST (compat)", async () => {
    const { router } = await makeEngine();
    const offResponse = await router.dispatch("/api/settings/models/toggles", {
      method: "PUT",
      body: JSON.stringify({
        toggles: [{ backendId: "cesium-agent", modelId: "acme/model-b", on: false }],
      }),
    });
    assert.equal(offResponse.status, 200);
    const state = await json<{
      byBackend: Record<string, Array<{ id: string; on: boolean }>>;
    }>(await router.dispatch("/api/settings/models"));
    const modelB = state.byBackend["cesium-agent"]?.find((entry) => entry.id === "acme/model-b");
    assert.equal(modelB?.on, false);
    const modelA = state.byBackend["cesium-agent"]?.find((entry) => entry.id === "acme/model-a");
    assert.equal(modelA?.on, true);

    const onResponse = await router.dispatch("/api/settings/models/toggles", {
      method: "POST",
      body: JSON.stringify({
        toggles: [{ backendId: "cesium-agent", modelId: "acme/model-b", on: true }],
      }),
    });
    assert.equal(onResponse.status, 200);
    const restored = await json<{
      byBackend: Record<string, Array<{ id: string; on: boolean }>>;
    }>(await router.dispatch("/api/settings/models"));
    assert.equal(
      restored.byBackend["cesium-agent"]?.every((entry) => entry.on),
      true
    );

    const invalid = await router.dispatch("/api/settings/models/toggles", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
  });

  test("global settings revision persists monotonically", async () => {
    const { router } = await makeEngine();
    const first = await json<{ revision: number }>(
      await router.dispatch("/api/settings/global")
    );
    const write = await json<{ revision: number }>(
      await router.dispatch("/api/settings/global", {
        method: "PUT",
        body: JSON.stringify({ settings: { agents: { submitCtrlEnter: true } } }),
      })
    );
    assert.equal(write.revision, first.revision + 1);
    const readBack = await json<{ revision: number; settings: Record<string, unknown> }>(
      await router.dispatch("/api/settings/global")
    );
    assert.equal(readBack.revision, write.revision);
    assert.deepEqual(readBack.settings, { agents: { submitCtrlEnter: true } });
  });

  test("conversation config options honor model access and enabled modes", async () => {
    const { router, workspaces } = await makeEngine();
    // Disable model-b and plan mode before creating a conversation.
    await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modelAccess: { entries: { "model-b": { enabled: false } } },
        modes: { enabled: { plan: false } },
      }),
    });
    const workspace = await workspaces.create({ name: "demo", root: "/workspaces/demo" });
    const response = await router.dispatch("/api/agents/conversations", {
      method: "POST",
      headers: { "x-opencursor-workspace-id": workspace.id },
      // Orchestration is a server-only mode: the browser machine clamps it.
      body: JSON.stringify({ mode: "orchestration" }),
    });
    assert.equal(response.status, 201);
    const payload = await json<{
      conversation: {
        config: { mode: string };
        configOptions: Array<{ id: string; options: Array<{ value: string }> }>;
      };
    }>(response);
    assert.equal(payload.conversation.config.mode, "agent");
    const modeOption = payload.conversation.configOptions.find((option) => option.id === "mode");
    assert.deepEqual(
      modeOption?.options.map((option) => option.value),
      ["agent", "ask"]
    );
    const modelOption = payload.conversation.configOptions.find(
      (option) => option.id === "model"
    );
    const modelValues = modelOption?.options.map((option) => option.value) ?? [];
    assert.ok(modelValues.includes("acme/model-a"));
    assert.equal(modelValues.includes("acme/model-b"), false);

    // Re-enable for any later suites sharing the kv cache.
    await router.dispatch("/api/settings/cesium-agent", {
      method: "PATCH",
      body: JSON.stringify({
        modelAccess: { entries: { "model-b": null } },
        modes: { enabled: { plan: true } },
      }),
    });
  });
});
