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
    assert.deepEqual(HARNESS_ORDER, [
      "cesium-agent",
      "cursor-sdk",
      "codex-app-server",
      "opencode-server",
      "gemini-acp",
      "claude-code-sdk",
      "pi-agent",
      "google-antigravity-cli",
    ]);
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
        eventId: "r1",
        conversationId: "c1",
        createdAt: 2,
        kind: "system_reminder",
        reminderId: "mode-m1",
        targetMessageId: "m1",
        reason: "mode",
        text: "<system-reminder>You are now in **ask mode**.</system-reminder>",
      },
      {
        seq: 3,
        eventId: "q1",
        conversationId: "c1",
        createdAt: 3,
        kind: "question",
        questionId: "question-1",
        prompt: "Choose a path",
        options: [{ id: "A", label: "Fast" }],
        status: "pending",
      },
      {
        seq: 4,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 4,
        kind: "subagent",
        subagentId: "sub-1",
        title: "Research",
        status: "completed",
        transcript: [],
        recentActivity: "Done",
      },
      {
        seq: 5,
        eventId: "cs1",
        conversationId: "c1",
        createdAt: 5,
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
    assert.equal(messages.some((message) => message.content?.includes("system-reminder")), false);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "worked-session" &&
          message.workedLabel === "Compressed context" &&
          message.workedEntries?.some(
            (entry) =>
              entry.kind === "compression" &&
              entry.compressedTurnCount === 12 &&
              entry.summary.includes("Important previous context")
          )
      )
    );
  });

  test("shows Compressed context after compression_summary", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u2",
        conversationId: "c2",
        createdAt: 1,
        kind: "user_message",
        messageId: "m2",
        content: "Continue",
      },
      {
        seq: 2,
        eventId: "cs2",
        conversationId: "c2",
        createdAt: 2,
        kind: "compression_summary",
        messageId: "summary-2",
        summary: "Earlier work on auth.",
        retainedTurnCount: 2,
        compressedTurnCount: 5,
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    assert.ok(
      messages.some(
        (message) =>
          message.type === "worked-session" &&
          message.workedLabel === "Compressed context" &&
          message.workedEntries?.some((entry) => entry.kind === "compression")
      )
    );
  });

  test("shows Compressing context during Cesium compression status", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Continue",
      },
      {
        seq: 2,
        eventId: "st1",
        conversationId: "c1",
        createdAt: 2,
        kind: "status",
        status: "running",
        detail: "Compressing context…",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    assert.ok(
      messages.some(
        (message) => message.type === "worked-session" && message.workedLabel === "Compressing context"
      )
    );
  });
});
