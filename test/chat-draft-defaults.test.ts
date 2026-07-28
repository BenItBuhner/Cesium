import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { updateChatDraftDefault } from "../src/lib/chat-draft-defaults.ts";
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
});
