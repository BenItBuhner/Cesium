import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConversationModelOptions } from "../packages/core/src/agent-chat";
import type { AgentBackendInfo, AgentConversationRecord } from "../packages/core/src/protocol";

const capabilities: AgentBackendInfo["capabilities"] = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: false,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
  supportsCompletionRetry: false,
};

const configOptions: AgentConversationRecord["configOptions"] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-k3",
    options: [
      { value: "kimi-k3", name: "kimi-k3 (techlit)" },
      {
        value: "gpt-6-astra",
        name: "GPT-6-Astra",
        metadata: { reasoningLevels: ["low", "high"], defaultReasoningEffort: "low" },
      },
    ],
  },
  {
    id: "model_reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

const backend: AgentBackendInfo = {
  id: "codex-app-server",
  label: "Codex",
  description: "",
  available: true,
  defaultMode: "agent",
  defaultModelId: "__default__",
  defaultModelName: "Codex App Server Default",
  capabilities,
  cachedConfigOptions: configOptions,
};

function conversation(modelId: string, modelName: string): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: "conv",
    workspaceId: "ws",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "codex-app-server", mode: "agent", modelId, modelName },
    providerSessionId: null,
    configOptions,
    capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
  };
}

test("models without reasoning levels keep a plain row next to reasoning variants", () => {
  const rows = buildConversationModelOptions(conversation("gpt-6-astra", "GPT-6-Astra"), [backend]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["kimi-k3", "gpt-6-astra::model_reasoning_effort::low", "gpt-6-astra::model_reasoning_effort::high"]
  );
  assert.equal(rows.find((row) => row.id === "kimi-k3")?.configSelections, undefined);
  assert.equal(rows.find((row) => row.selected)?.id, "gpt-6-astra::model_reasoning_effort::low");
});

test("backend default sentinel selects the catalog's current model", () => {
  const rows = buildConversationModelOptions(conversation("__default__", "Default (kimi-k3)"), [backend]);
  const selected = rows.filter((row) => row.selected);
  assert.deepEqual(selected.map((row) => row.id), ["kimi-k3"]);
  assert.equal(selected[0]?.name, "kimi-k3 (techlit)");
});

test("explicit catalog ids still win over the current value", () => {
  const rows = buildConversationModelOptions(conversation("kimi-k3", "kimi-k3 (techlit)"), [backend]);
  assert.deepEqual(rows.filter((row) => row.selected).map((row) => row.id), ["kimi-k3"]);
});
