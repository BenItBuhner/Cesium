import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveLastUsedDraftModel,
  updateChatDraftDefault,
} from "../src/lib/chat-draft-defaults.ts";
import { createDefaultWorkspaceSession } from "../src/lib/workspace-session.ts";
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

describe("chat draft defaults", () => {
  test("preserves exact selected model identity and backend together", () => {
    const staleModel = model({
      id: "302ai/claude-3-5-haiku-latest",
      modelValue: "302ai/claude-3-5-haiku-latest",
      name: "302.AI/Claude 3.5 Haiku",
      backendId: "cesium-agent",
    });
    const chat = {
      ...createDefaultWorkspaceSession([], staleModel).chat,
      backendId: "cursor-sdk" as const,
    };
    const selected = model({
      id: "helicone/gpt-5",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5",
      backendId: "cesium-agent",
      configSelections: [{ configId: "reasoning", value: "high" }],
    });

    const next = updateChatDraftDefault(chat, {
      backendId: "cursor-sdk",
      mode: "agent",
      model: selected,
    });

    assert.equal(next.backendId, "cesium-agent");
    assert.equal(next.model.modelValue, "helicone/gpt-5");
    assert.deepEqual(next.model.configSelections, [{ configId: "reasoning", value: "high" }]);
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
    const chat = createDefaultWorkspaceSession([], model({
      id: "composer-2.5",
      modelValue: "composer-2.5",
      name: "Composer 2.5",
      backendId: "cursor-sdk",
    })).chat;

    const next = updateChatDraftDefault(chat, {
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
    const chat = createDefaultWorkspaceSession([], cesiumModel).chat;

    const afterCesiumPick = updateChatDraftDefault(chat, {
      backendId: "cesium-agent",
      mode: "agent",
      model: cesiumModel,
    });
    const afterCursorPick = updateChatDraftDefault(afterCesiumPick, {
      backendId: "cursor-sdk",
      mode: "agent",
      model: cursorModel,
    });

    assert.equal(
      afterCursorPick.lastModelByBackend?.["cesium-agent"]?.modelValue,
      "helicone/gpt-5"
    );
    assert.equal(
      afterCursorPick.lastModelByBackend?.["cursor-sdk"]?.modelValue,
      "composer-2.5"
    );
  });

  test("returns the same state object when nothing changed", () => {
    const picked = model({
      id: "helicone/gpt-5",
      modelValue: "helicone/gpt-5",
      name: "Helicone/OpenAI GPT 5",
      backendId: "cesium-agent",
    });
    const chat = updateChatDraftDefault(
      createDefaultWorkspaceSession([], picked).chat,
      { backendId: "cesium-agent", mode: "agent", model: picked }
    );

    const next = updateChatDraftDefault(chat, {
      backendId: "cesium-agent",
      mode: "agent",
      model: picked,
    });

    assert.equal(next, chat);
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

  function chatWith(current: ModelInfo, remembered?: ModelInfo) {
    const chat = createDefaultWorkspaceSession([], current).chat;
    return {
      ...chat,
      backendId: "cesium-agent" as const,
      lastModelByBackend: remembered
        ? { [backend.id]: remembered }
        : chat.lastModelByBackend,
    };
  }

  test("keeps the exact variant row the user last picked", () => {
    const chat = chatWith(
      model({
        id: "helicone/gpt-5::thought::low",
        modelValue: "helicone/gpt-5",
        name: "Helicone/OpenAI GPT 5 Low",
        backendId: "cesium-agent",
        configSelections: [{ configId: "thought", value: "low" }],
      })
    );

    const resolved = resolveLastUsedDraftModel(chat, backend, catalog);
    assert.equal(resolved?.id, "helicone/gpt-5::thought::low");
  });

  test("matches config selections when row ids changed", () => {
    const chat = chatWith(
      model({
        id: "stale-row-id",
        modelValue: "helicone/gpt-5",
        name: "Helicone/OpenAI GPT 5",
        backendId: "cesium-agent",
        configSelections: [{ configId: "thought", value: "low" }],
      })
    );

    const resolved = resolveLastUsedDraftModel(chat, backend, catalog);
    assert.equal(resolved?.id, "helicone/gpt-5::thought::low");
  });

  test("falls back to the per-backend memory when the session model belongs to another backend", () => {
    const chat = {
      ...chatWith(
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

    const resolved = resolveLastUsedDraftModel(chat, backend, catalog);
    assert.equal(resolved?.modelValue, "openai/gpt-5.1");
  });

  test("trusts the last-used pick over an unhydrated placeholder catalog", () => {
    const chat = chatWith(
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

    const resolved = resolveLastUsedDraftModel(chat, backend, placeholderCatalog);
    assert.equal(resolved?.modelValue, "techlit/kimi-k3");
  });

  test("does not resurrect models missing from a hydrated catalog", () => {
    const chat = chatWith(
      model({
        id: "removed/model",
        modelValue: "removed/model",
        name: "Removed Model",
        backendId: "cesium-agent",
      })
    );

    const resolved = resolveLastUsedDraftModel(chat, backend, catalog);
    assert.equal(resolved, null);
  });

  test("never adopts another backend's model for a placeholder catalog", () => {
    const chat = {
      ...chatWith(
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

    const resolved = resolveLastUsedDraftModel(chat, backend, placeholderCatalog);
    assert.equal(resolved, null);
  });
});
