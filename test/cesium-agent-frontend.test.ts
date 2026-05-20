import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HARNESS_LABELS, HARNESS_ORDER } from "../src/components/editor/agent-harness-settings.tsx";
import {
  isAgentCesiumTurnActive,
  isAgentCesiumPauseDraining,
  isAgentConversationBusy,
  isAgentConversationPaused,
  mergeAgentConversationStatusFromEvent,
  projectAgentEventsToChatMessages,
} from "../src/lib/agent-chat.ts";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("Cesium Agent frontend integration", () => {
  test("lists Cesium Agent first in harness settings", () => {
    assert.equal(HARNESS_ORDER[0], "cesium-agent");
    assert.equal(HARNESS_ORDER.length, 6);
    assert.equal(HARNESS_LABELS["cesium-agent"], "Cesium Agent (Beta)");
  });

  test("composer busy helpers treat pause drain and paused as active turn", () => {
    assert.equal(isAgentConversationBusy("running"), true);
    assert.equal(isAgentConversationBusy("pausing"), true);
    assert.equal(isAgentConversationBusy("paused"), false);
    assert.equal(isAgentConversationPaused("paused"), true);
    assert.equal(isAgentCesiumTurnActive("paused"), true);
    assert.equal(isAgentCesiumTurnActive("idle"), false);
    assert.equal(isAgentCesiumPauseDraining("pause_requested"), true);
    assert.equal(isAgentCesiumPauseDraining("pausing"), true);
    assert.equal(isAgentCesiumPauseDraining("paused"), false);
  });

  test("mergeAgentConversationStatusFromEvent applies pause and cancel statuses", () => {
    const conversation: AgentConversationRecord = {
      schemaVersion: 1,
      id: "c1",
      workspaceId: "ws-1",
      title: "Test",
      createdAt: 1,
      updatedAt: 1,
      lastEventSeq: 0,
      status: "running",
      config: {
        backendId: "cesium-agent",
        mode: "agent",
        modelId: "openai/gpt-5.1",
        modelName: "GPT-5.1",
      },
      providerSessionId: "cesium-c1",
      configOptions: [],
      capabilities: {
        supportsLoadSession: true,
        supportsSessionResume: false,
        supportsPermissions: true,
        supportsQuestions: true,
        supportsToolCalls: true,
        supportsQueuedPrompts: true,
        supportsHandoff: false,
        supportsSubagents: true,
        supportsMcp: true,
      },
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      experimental: true,
      archivedAt: null,
      lastReadSeq: 0,
      queuedPrompts: [],
    };

    const paused = mergeAgentConversationStatusFromEvent(conversation, {
      seq: 2,
      eventId: "s1",
      conversationId: "c1",
      createdAt: 2,
      kind: "status",
      status: "paused",
      detail: "Cesium is paused.",
    });
    assert.equal(paused?.status, "paused");

    const cancelled = mergeAgentConversationStatusFromEvent(conversation, {
      seq: 3,
      eventId: "s2",
      conversationId: "c1",
      createdAt: 3,
      kind: "status",
      status: "cancelled",
      detail: "Cesium turn cancelled.",
    });
    assert.equal(cancelled?.status, "cancelled");
  });

  test("projects Cesium question, subagent, and compression events", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Start",
      },
      {
        seq: 2,
        eventId: "q1",
        conversationId: "c1",
        createdAt: 2,
        kind: "question",
        questionId: "question-1",
        prompt: "Choose a path",
        options: [{ id: "A", label: "Fast" }],
        status: "pending",
      },
      {
        seq: 3,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 3,
        kind: "subagent",
        subagentId: "sub-1",
        title: "Research",
        status: "completed",
        transcript: [],
        recentActivity: "Done",
      },
      {
        seq: 4,
        eventId: "cs1",
        conversationId: "c1",
        createdAt: 4,
        kind: "compression_summary",
        messageId: "summary-1",
        summary: "Important previous context.",
        retainedTurnCount: 3,
        compressedTurnCount: 12,
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    assert.ok(messages.some((message) => message.type === "ask-question"));
    assert.ok(messages.some((message) => message.type === "subagent"));
    assert.ok(
      messages.some(
        (message) =>
          message.type === "worked-session" &&
          message.workedEntries?.some(
            (entry) => entry.kind === "reasoning" && entry.text.includes("Compressed 12")
          )
      )
    );
  });
});
