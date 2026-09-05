import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  adoptLegacyComposerFields,
  createDefaultComposerDefaults,
  extractLegacyComposerFieldsFromChatSession,
  normalizeComposerDefaults,
  resolveLastUsedDraftModel,
  updateComposerDraftDefault,
  updateComposerDraftMode,
  updateComposerDraftProfile,
  type ComposerDefaultsState,
} from "../src/lib/chat-draft-defaults.ts";
import { NO_MODEL_PLACEHOLDER } from "../packages/core/src/agent-chat.ts";
import type { AgentConversationRecord, AgentProviderCapabilities } from "../src/lib/agent-types.ts";
import type { ModelInfo } from "../src/lib/types.ts";

const capabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: true,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
  supportsCompletionRetry: false,
};

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  return {
    provider: "openai",
    ...partial,
  };
}

function composerWith(current: ModelInfo, backendId: ComposerDefaultsState["backendId"] = "cesium-agent") {
  return { ...createDefaultComposerDefaults(), model: current, backendId };
}

describe("composer draft defaults", () => {
  test("preserves exact selected model identity and backend together", () => {
    const staleModel = model({
      id: "302ai/claude-3-5-haiku-latest",
      modelValue: "302ai/claude-3-5-haiku-latest",
      name: "302.AI/Claude 3.5 Haiku",
      backendId: "cesium-agent",
    });
    const composer = composerWith(staleModel, "cursor-sdk");
    const selected = model({
      id: "helicone/gpt-5",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5",
      backendId: "cesium-agent",
      configSelections: [{ configId: "reasoning", value: "high" }],
    });

    const next = updateComposerDraftDefault(composer, {
      backendId: "cursor-sdk",
      mode: "agent",
      model: selected,
    });

    assert.equal(next.backendId, "cesium-agent");
    assert.equal(next.model.modelValue, "helicone/gpt-5");
    assert.deepEqual(next.model.configSelections, [{ configId: "reasoning", value: "high" }]);
    assert.ok(next.updatedAt > 0, "an explicit pick stamps the account default");
  });

  test("updates the new-chat default without mutating an existing conversation config", () => {
    const conversation: AgentConversationRecord = {
      schemaVersion: 1,
      id: "conv-1",
      workspaceId: "workspace-1",
      title: "Existing",
      createdAt: 1,
      updatedAt: 1,
      lastEventSeq: 1,
      status: "idle",
      config: {
        backendId: "cursor-sdk",
        mode: "ask",
        modelId: "composer-2.5",
        modelName: "Composer 2.5",
      },
      providerSessionId: null,
      configOptions: [],
      capabilities,
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      experimental: false,
      archivedAt: null,
      lastReadSeq: 1,
      queuedPrompts: [],
    };
    const composer = composerWith(
      model({
        id: "composer-2.5",
        modelValue: "composer-2.5",
        name: "Composer 2.5",
        backendId: "cursor-sdk",
      }),
      "cursor-sdk"
    );

    const next = updateComposerDraftDefault(composer, {
      backendId: "cesium-agent",
      mode: "agent",
      model: model({
        id: "helicone/gpt-5",
        modelValue: "helicone/gpt-5",
        name: "Helicone/OpenAI GPT 5",
        backendId: "cesium-agent",
      }),
    });

    assert.equal(next.backendId, "cesium-agent");
    assert.equal(next.model.modelValue, "helicone/gpt-5");
    assert.deepEqual(conversation.config, {
      backendId: "cursor-sdk",
      mode: "ask",
      modelId: "composer-2.5",
      modelName: "Composer 2.5",
    });
  });

  test("remembers the last-used model per backend", () => {
    const cesiumModel = model({
      id: "helicone/gpt-5",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5",
      backendId: "cesium-agent",
    });
    const cursorModel = model({
      id: "composer-2.5",
      modelValue: "composer-2.5",
      name: "Composer 2.5",
      backendId: "cursor-sdk",
    });

    const afterCesiumPick = updateComposerDraftDefault(composerWith(cesiumModel), {
      backendId: "cesium-agent",
      mode: "agent",
      model: cesiumModel,
    });
    const afterCursorPick = updateComposerDraftDefault(afterCesiumPick, {
      backendId: "cursor-sdk",
      mode: "agent",
      model: cursorModel,
    });

    assert.equal(afterCursorPick.lastModelByBackend["cesium-agent"]?.modelValue, "helicone/gpt-5");
    assert.equal(afterCursorPick.lastModelByBackend["cursor-sdk"]?.modelValue, "composer-2.5");
  });

  test("returns the same state object when nothing changed", () => {
    const picked = model({
      id: "helicone/gpt-5",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5",
      backendId: "cesium-agent",
    });
    const composer = updateComposerDraftDefault(composerWith(picked), {
      backendId: "cesium-agent",
      mode: "agent",
      model: picked,
    });

    const next = updateComposerDraftDefault(composer, {
      backendId: "cesium-agent",
      mode: "agent",
      model: picked,
    });

    assert.equal(next, composer);
    assert.equal(updateComposerDraftMode(composer, composer.mode), composer);
    assert.equal(updateComposerDraftProfile(composer, undefined), composer);
  });

  test("mode and profile setters stamp updatedAt and drop empty profiles", () => {
    const composer = createDefaultComposerDefaults();
    const plan = updateComposerDraftMode(composer, "plan", 42);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.updatedAt, 42);
    const work = updateComposerDraftProfile(plan, "work", 43);
    assert.equal(work.profileId, "work");
    const cleared = updateComposerDraftProfile(work, "  ", 44);
    assert.equal("profileId" in cleared, false);
    assert.equal(cleared.updatedAt, 44);
  });
});

describe("resolveLastUsedDraftModel", () => {
  const catalog: ModelInfo[] = [
    model({
      id: "openai/gpt-5.1",
      modelValue: "openai/gpt-5.1",
      name: "OpenAI/GPT-5.1",
      backendId: "cesium-agent",
    }),
    model({
      id: "helicone/gpt-5::thought::high",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5 High",
      backendId: "cesium-agent",
      configSelections: [{ configId: "thought", value: "high" }],
    }),
    model({
      id: "helicone/gpt-5::thought::low",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5 Low",
      backendId: "cesium-agent",
      configSelections: [{ configId: "thought", value: "low" }],
    }),
  ];
  const backend = { id: "cesium-agent" as const };

  function composerFor(current: ModelInfo, remembered?: ModelInfo) {
    const composer = composerWith(current);
    return {
      ...composer,
      lastModelByBackend: remembered ? { [backend.id]: remembered } : composer.lastModelByBackend,
    };
  }

  test("keeps the exact variant row the user last picked", () => {
    const composer = composerFor(
      model({
        id: "helicone/gpt-5::thought::low",
        modelValue: "helicone/gpt-5",
        name: "Helicone/OpenAI GPT 5 Low",
        backendId: "cesium-agent",
        configSelections: [{ configId: "thought", value: "low" }],
      })
    );

    const resolved = resolveLastUsedDraftModel(composer, backend, catalog);
    assert.equal(resolved?.id, "helicone/gpt-5::thought::low");
  });

  test("matches config selections when row ids changed", () => {
    const composer = composerFor(
      model({
        id: "stale-row-id",
        modelValue: "helicone/gpt-5",
        name: "Helicone/OpenAI GPT 5",
        backendId: "cesium-agent",
        configSelections: [{ configId: "thought", value: "low" }],
      })
    );

    const resolved = resolveLastUsedDraftModel(composer, backend, catalog);
    assert.equal(resolved?.id, "helicone/gpt-5::thought::low");
  });

  test("falls back to the per-backend memory when the current model belongs to another backend", () => {
    const composer = {
      ...composerFor(
        model({
          id: "composer-2.5",
          modelValue: "composer-2.5",
          name: "Composer 2.5",
          backendId: "cursor-sdk",
        }),
        model({
          id: "openai/gpt-5.1",
          modelValue: "openai/gpt-5.1",
          name: "OpenAI/GPT-5.1",
          backendId: "cesium-agent",
        })
      ),
      backendId: "cursor-sdk" as const,
    };

    const resolved = resolveLastUsedDraftModel(composer, backend, catalog);
    assert.equal(resolved?.modelValue, "openai/gpt-5.1");
  });

  test("trusts the last-used pick over an unhydrated placeholder catalog", () => {
    const composer = composerFor(
      model({
        id: "techlit/kimi-k3",
        modelValue: "techlit/kimi-k3",
        name: "Techlit/Kimi K3",
        backendId: "cesium-agent",
      })
    );
    const placeholderCatalog = [
      model({
        id: "openai/gpt-5.1",
        modelValue: "openai/gpt-5.1",
        name: "OpenAI/GPT-5.1",
        backendId: "cesium-agent",
      }),
    ];

    const resolved = resolveLastUsedDraftModel(composer, backend, placeholderCatalog);
    assert.equal(resolved?.modelValue, "techlit/kimi-k3");
  });

  test("does not resurrect models missing from a hydrated catalog", () => {
    const composer = composerFor(
      model({
        id: "removed/model",
        modelValue: "removed/model",
        name: "Removed Model",
        backendId: "cesium-agent",
      })
    );

    const resolved = resolveLastUsedDraftModel(composer, backend, catalog);
    assert.equal(resolved, null);
  });

  test("never adopts another backend's model for a placeholder catalog", () => {
    const composer = {
      ...composerFor(
        model({
          id: "composer-2.5",
          modelValue: "composer-2.5",
          name: "Composer 2.5",
        })
      ),
      backendId: "cesium-agent" as const,
    };
    const placeholderCatalog = [
      model({
        id: "openai/gpt-5.1",
        modelValue: "openai/gpt-5.1",
        name: "OpenAI/GPT-5.1",
        backendId: "cesium-agent",
      }),
    ];

    const resolved = resolveLastUsedDraftModel(composer, backend, placeholderCatalog);
    assert.equal(resolved, null);
  });
});

describe("composer defaults normalization", () => {
  test("defaults are the no-model placeholder on the Cesium harness, never stamped", () => {
    const defaults = createDefaultComposerDefaults();
    assert.equal(defaults.backendId, "cesium-agent");
    assert.equal(defaults.mode, "agent");
    assert.equal(defaults.model.id, NO_MODEL_PLACEHOLDER.id);
    assert.equal(defaults.updatedAt, 0);
    assert.deepEqual(normalizeComposerDefaults(undefined), defaults);
    assert.deepEqual(normalizeComposerDefaults("garbage"), defaults);
  });

  test("normalizes persisted picks, remaps renamed harnesses and drops unknown ones", () => {
    const normalized = normalizeComposerDefaults({
      backendId: "claude-adapter",
      mode: "plan",
      model: {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        provider: "not-a-provider",
        backendId: "claude-adapter",
        selected: true,
        variantParameters: [{ id: "x", value: "y" }],
      },
      lastModelByBackend: {
        "opencode-acp": { id: "auto", name: "Auto" },
        "made-up-harness": { id: "nope", name: "Nope" },
        "cesium-agent": { id: "", name: "missing id" },
      },
      profileId: "  work  ",
      statusBarVisibility: { repo: false },
      pillsVisibility: { work: false },
      updatedAt: 17,
    });
    assert.equal(normalized.backendId, "claude-code-sdk");
    assert.equal(normalized.mode, "plan");
    assert.equal(normalized.model.provider, "auto");
    assert.equal(normalized.model.backendId, "claude-code-sdk");
    assert.equal("selected" in normalized.model, false);
    assert.equal("variantParameters" in normalized.model, false);
    assert.deepEqual(Object.keys(normalized.lastModelByBackend), ["opencode-server"]);
    assert.equal(normalized.profileId, "work");
    assert.equal(normalized.statusBarVisibility.repo, false);
    assert.equal(normalized.statusBarVisibility.branch, true);
    assert.equal(normalized.pillsVisibility.work, false);
    assert.equal(normalized.updatedAt, 17);
  });

  test("folds the legacy explicit status-bar default only when no composer slice exists", () => {
    const fromLegacy = normalizeComposerDefaults(undefined, {
      legacyStatusBarVisibility: { repo: false, branch: false },
    });
    assert.equal(fromLegacy.statusBarVisibility.repo, false);
    assert.equal(fromLegacy.statusBarVisibility.goal, true);

    const withSlice = normalizeComposerDefaults(
      { statusBarVisibility: { goal: false } },
      { legacyStatusBarVisibility: { repo: false } }
    );
    assert.equal(withSlice.statusBarVisibility.repo, true);
    assert.equal(withSlice.statusBarVisibility.goal, false);
  });
});

describe("legacy per-workspace draft migration", () => {
  const legacyChat = {
    tabs: [],
    backendId: "gemini-acp",
    mode: "plan",
    model: { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google", backendId: "gemini-acp" },
    lastModelByBackend: {
      "cesium-agent": { id: "techlit/kimi-k3", name: "Kimi K3", provider: "auto", backendId: "cesium-agent" },
    },
    profileId: "work",
    composerStatusBarVisibility: { repo: false, branch: true, goal: true, context: true },
    composerPillsVisibility: { diff: false, conflicts: true, sync: true, work: true, actions: true },
    scrollTopByTabId: {},
  };

  test("extracts the draft fields older sessions persisted inside chat", () => {
    const legacy = extractLegacyComposerFieldsFromChatSession(legacyChat);
    assert.ok(legacy);
    assert.equal(legacy.backendId, "google-antigravity-cli");
    assert.equal(legacy.mode, "plan");
    assert.equal(legacy.model?.id, "gemini-2.5-pro");
    assert.equal(legacy.lastModelByBackend?.["cesium-agent"]?.id, "techlit/kimi-k3");
    assert.equal(legacy.profileId, "work");
    assert.equal(legacy.statusBarVisibility?.repo, false);
    assert.equal(legacy.pillsVisibility?.diff, false);
    assert.equal(extractLegacyComposerFieldsFromChatSession({ tabs: [], scrollTopByTabId: {} }), null);
    assert.equal(extractLegacyComposerFieldsFromChatSession(null), null);
  });

  test("adopts legacy picks exactly once into an untouched account", () => {
    const legacy = extractLegacyComposerFieldsFromChatSession(legacyChat);
    const adopted = adoptLegacyComposerFields(createDefaultComposerDefaults(), legacy, 99);
    assert.equal(adopted.backendId, "google-antigravity-cli");
    assert.equal(adopted.model.id, "gemini-2.5-pro");
    assert.equal(adopted.lastModelByBackend["cesium-agent"]?.id, "techlit/kimi-k3");
    assert.equal(adopted.profileId, "work");
    assert.equal(adopted.statusBarVisibility.repo, false);
    assert.equal(adopted.pillsVisibility.diff, false);
    assert.equal(adopted.updatedAt, 99);

    // A second workspace's leftovers must not override the adopted account state.
    const secondWorkspace = extractLegacyComposerFieldsFromChatSession({
      ...legacyChat,
      backendId: "cursor-sdk",
      model: { id: "composer-2.5", name: "Composer 2.5", provider: "cursor", backendId: "cursor-sdk" },
    });
    assert.equal(adoptLegacyComposerFields(adopted, secondWorkspace, 100), adopted);
  });

  test("never overrides an account that already made a choice", () => {
    const picked = updateComposerDraftDefault(
      createDefaultComposerDefaults(),
      {
        backendId: "cesium-agent",
        mode: "agent",
        model: model({ id: "openai/gpt-5.1", name: "GPT-5.1", backendId: "cesium-agent" }),
      },
      5
    );
    const legacy = extractLegacyComposerFieldsFromChatSession(legacyChat);
    assert.equal(adoptLegacyComposerFields(picked, legacy), picked);
  });

  test("keeps account chrome defaults that differ from factory values", () => {
    const account = {
      ...createDefaultComposerDefaults(),
      statusBarVisibility: { repo: true, branch: false, goal: true, context: true },
    };
    const legacy = extractLegacyComposerFieldsFromChatSession(legacyChat);
    const adopted = adoptLegacyComposerFields(account, legacy, 7);
    // Model picks adopt (account never picked one) but the explicit status bar stays.
    assert.equal(adopted.backendId, "google-antigravity-cli");
    assert.deepEqual(adopted.statusBarVisibility, account.statusBarVisibility);
    assert.equal(adopted.pillsVisibility.diff, false);
  });
});
