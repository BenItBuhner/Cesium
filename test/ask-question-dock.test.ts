import assert from "node:assert/strict";
import test from "node:test";
import {
  findDockedAskQuestion,
  findLatestPendingQuestionEvent,
  formatAskQuestionSubmission,
  hideDockedAskFromScroll,
} from "../src/lib/ask-question-dock.ts";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agent-types.ts";
import type { AskQuestionStep, ChatMessage } from "../src/lib/types.ts";

function questionEvent(
  overrides: Partial<Extract<AgentStoredEvent, { kind: "question" }>> = {}
): Extract<AgentStoredEvent, { kind: "question" }> {
  return {
    seq: 1,
    eventId: "evt-question",
    conversationId: "conv-1",
    createdAt: Date.now(),
    kind: "question",
    questionId: "q-1",
    prompt: "What next?",
    options: [
      { id: "a", label: "Build" },
      { id: "b", label: "Debug" },
    ],
    status: "pending",
    ...overrides,
  };
}

function baseConversation(
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  return {
    id: "conv-1",
    title: "Test",
    createdAt: 0,
    updatedAt: 0,
    status: "awaiting_question",
    lastEventSeq: 1,
    lastError: null,
    archivedAt: null,
    providerSessionId: "cesium-conv-1",
    config: {
      backendId: "cesium",
      mode: "agent",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    configOptions: [],
    capabilities: {
      supportsLoadSession: true,
      supportsModeSelection: true,
      supportsModelSelection: true,
      supportsSlashCommands: false,
      supportsPermissions: true,
      supportsToolCalls: true,
      supportsStructuredPlans: false,
      supportsTodos: true,
      supportsSessionResume: true,
      supportsPromptImages: false,
      supportsInlineReasoning: true,
      supportsCompletionRetry: true,
    },
    experimental: false,
    pendingPermission: null,
    pendingQuestion: { questionId: "q-1", requestedAt: 0 },
    queuedPrompts: [],
    ...overrides,
  };
}

test("findLatestPendingQuestionEvent returns the latest pending question", () => {
  const events: AgentStoredEvent[] = [
    questionEvent({ questionId: "q-1", status: "answered", answer: "Build" }),
    questionEvent({ questionId: "q-2", status: "pending", prompt: "Pick one" }),
  ];
  const pending = findLatestPendingQuestionEvent(events);
  assert.equal(pending?.questionId, "q-2");
  assert.equal(pending?.prompt, "Pick one");
});

test("findDockedAskQuestion builds steps from pending question events", () => {
  const docked = findDockedAskQuestion({
    events: [questionEvent()],
    conversation: baseConversation(),
  });
  assert.ok(docked);
  assert.equal(docked?.questionId, "q-1");
  assert.equal(docked?.steps[0]?.title, "What next?");
  assert.equal(docked?.steps[0]?.options.length, 3);
});

test("hideDockedAskFromScroll removes docked ask-question messages", () => {
  const messages: ChatMessage[] = [
    { id: "u-1", type: "user", content: "Hi" },
    {
      id: "question-q-1",
      type: "ask-question",
      questionTitle: "What next?",
      options: [{ letter: "A", text: "Build" }],
    },
  ];
  const hidden = hideDockedAskFromScroll(messages, {
    questionId: "q-1",
    steps: [],
  });
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0]?.id, "u-1");
});

test("formatAskQuestionSubmission joins step answers", () => {
  const steps: AskQuestionStep[] = [
    {
      id: "step-1",
      title: "Goal",
      options: [
        { letter: "A", text: "Build" },
        { letter: "B", text: "Other", isOther: true, placeholder: "Describe" },
      ],
    },
  ];
  const text = formatAskQuestionSubmission(steps, {
    "step-1": { letter: "B", otherDraft: "Ship billing" },
  });
  assert.equal(text, "Goal: Ship billing");
});
