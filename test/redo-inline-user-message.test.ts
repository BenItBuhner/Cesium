import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentBackendInfo,
  AgentConversationRecord,
  AgentProviderCapabilities,
} from "../src/lib/agent-types";
import { buildRedoComposerSeedFromConversation } from "../src/components/chat/useRedoInlineUserMessage";

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
};

const backend: AgentBackendInfo = {
  id: "cursor-acp",
  label: "Cursor",
  description: "Cursor agent",
  available: true,
  defaultMode: "agent",
  defaultModelId: "auto",
  defaultModelName: "Auto",
  capabilities,
  cachedConfigOptions: [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto" },
        { value: "gpt-5.5", name: "GPT-5.5" },
      ],
    },
  ],
};

function conversation(
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: "conv-1",
    workspaceId: "workspace-1",
    title: "Existing chat",
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 3,
    status: "idle",
    config: {
      backendId: "cursor-acp",
      mode: "ask",
      modelId: "gpt-5.5",
      modelName: "GPT-5.5",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities,
    pendingPermission: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    ...overrides,
  };
}

test("redo composer seed falls back to conversation config", () => {
  const seed = buildRedoComposerSeedFromConversation(conversation(), [backend], {});

  assert.equal(seed.backendId, "cursor-acp");
  assert.equal(seed.mode, "ask");
  assert.equal(seed.model.modelValue, "gpt-5.5");
  assert.equal(seed.model.name, "GPT-5.5");
});

