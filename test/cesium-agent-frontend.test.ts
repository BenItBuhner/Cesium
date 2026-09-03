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
      "devin-acp",
      "grok-build",
      "claude-code-sdk",
      "pi-agent",
      "google-antigravity-acp",
    ]);
    assert.equal(HARNESS_LABELS["cesium-agent"], "Cesium Agent (Beta)");
    assert.equal(HARNESS_LABELS["opencode-server"], "OpenCode");
    assert.equal(HARNESS_LABELS["devin-acp"], "Devin");
    assert.equal(HARNESS_LABELS["google-antigravity-acp"], "Google Antigravity");
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

  test("merges legacy V1 subagent tool_call + subagent event + wrapped update into one card", () => {
    // Legacy stored sequence: tool_call keyed by toolCallId, subagent event keyed by a
    // random UUID, tool_call_update raw wrapped as `{ request, result }`.
    const instructions = "Research all current Anthropic models and report back.";
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Research AI models",
      },
      {
        seq: 2,
        eventId: "t1",
        conversationId: "c1",
        createdAt: 2,
        kind: "tool_call",
        toolCallId: "tool-abc",
        title: "Subagent Anthropic models research",
        toolKind: "subagent",
        status: "in_progress",
        detail: JSON.stringify({ title: "Anthropic models research", instructions }),
        raw: {
          id: "tool-abc",
          name: "subagent",
          arguments: { title: "Anthropic models research", instructions },
        },
      },
      {
        seq: 3,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 3,
        kind: "subagent",
        subagentId: "uuid-111",
        title: "Anthropic models research",
        status: "completed",
        transcript: [
          {
            seq: 0,
            eventId: "st-u",
            conversationId: "c1",
            createdAt: 3,
            kind: "user_message",
            messageId: "sm1",
            content: instructions,
          },
          {
            seq: 0,
            eventId: "st-a",
            conversationId: "c1",
            createdAt: 3,
            kind: "assistant_message_chunk",
            messageId: "sm2",
            text: "Anthropic currently ships Claude models across three tiers.",
          },
        ],
        recentActivity: "Anthropic currently ships Claude models across three tiers.",
      },
      {
        seq: 4,
        eventId: "t2",
        conversationId: "c1",
        createdAt: 4,
        kind: "tool_call_update",
        toolCallId: "tool-abc",
        title: "Subagent Anthropic models research",
        toolKind: "subagent",
        status: "completed",
        detail: "Subagent uuid-111 completed: Anthropic currently ships Claude models across three tiers.",
        raw: {
          request: {
            id: "tool-abc",
            name: "subagent",
            arguments: { title: "Anthropic models research", instructions },
          },
          result:
            "Subagent uuid-111 completed: Anthropic currently ships Claude models across three tiers.",
        },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    const cards = messages.filter((message) => message.type === "subagent");
    assert.equal(cards.length, 1, `expected one subagent card, got ${cards.length}`);
    const card = cards[0]!;
    assert.equal(card.subagentStatus, "completed");
    assert.equal(card.subagentComplete, true);
    assert.equal(card.subagentTitle, "Anthropic models research");
    assert.ok(
      card.subagentTranscript?.some((row) =>
        row.content?.includes("Anthropic currently ships Claude models")
      ),
      "card should carry the real transcript"
    );
    assert.equal(
      card.subagentTranscript?.some((row) => row.content?.includes("No transcript details")),
      false,
      "placeholder transcript must not survive the merge"
    );
    assert.equal(card.recentActivity?.includes("No transcript details"), false);
  });

  test("merges V1 subagent flow keyed by toolCallId with running + completed events", () => {
    const instructions = "Summarize the repository layout.";
    const base = {
      conversationId: "c1",
      raw: {
        id: "tool-xyz",
        name: "subagent",
        arguments: { title: "Repo summary", instructions },
      },
    };
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Go",
      },
      {
        seq: 2,
        eventId: "t1",
        createdAt: 2,
        kind: "tool_call",
        toolCallId: "tool-xyz",
        title: "Subagent Repo summary",
        toolKind: "subagent",
        status: "in_progress",
        detail: "{}",
        ...base,
      },
      {
        seq: 3,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 3,
        kind: "subagent",
        subagentId: "tool-xyz",
        title: "Repo summary",
        status: "running",
        transcript: [
          {
            seq: 0,
            eventId: "st-u",
            conversationId: "c1",
            createdAt: 3,
            kind: "user_message",
            messageId: "sm1",
            content: instructions,
          },
        ],
        recentActivity: instructions,
      },
      {
        seq: 4,
        eventId: "s2",
        conversationId: "c1",
        createdAt: 4,
        kind: "subagent",
        subagentId: "tool-xyz",
        title: "Repo summary",
        status: "completed",
        transcript: [
          {
            seq: 0,
            eventId: "st-u",
            conversationId: "c1",
            createdAt: 3,
            kind: "user_message",
            messageId: "sm1",
            content: instructions,
          },
          {
            seq: 0,
            eventId: "st-a",
            conversationId: "c1",
            createdAt: 4,
            kind: "assistant_message_chunk",
            messageId: "sm2",
            text: "The repo is a Next.js app with a Bun server.",
          },
        ],
        recentActivity: "The repo is a Next.js app with a Bun server.",
      },
      {
        seq: 5,
        eventId: "t2",
        conversationId: "c1",
        createdAt: 5,
        kind: "tool_call_update",
        toolCallId: "tool-xyz",
        title: "Subagent Repo summary",
        toolKind: "subagent",
        status: "completed",
        detail: "Subagent tool-xyz completed: The repo is a Next.js app with a Bun server.",
        raw: {
          request: base.raw,
          result: "Subagent tool-xyz completed: The repo is a Next.js app with a Bun server.",
        },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    const cards = messages.filter((message) => message.type === "subagent");
    assert.equal(cards.length, 1, `expected one subagent card, got ${cards.length}`);
    const card = cards[0]!;
    assert.equal(card.subagentStatus, "completed");
    assert.equal(card.subagentTitle, "Repo summary");
    assert.ok(
      card.subagentTranscript?.some((row) =>
        row.content?.includes("The repo is a Next.js app with a Bun server.")
      )
    );
    assert.equal(
      card.subagentTranscript?.some(
        (row) => row.type === "worked-session" && row.loading
      ),
      false,
      "settled card must not keep the live 'Working' row from the running-state transcript"
    );
  });

  test("wrapped tool_call_update settles a subagent card stuck running", () => {
    // Tool crashed before emitting a completed subagent event: the failed
    // tool_call_update must flip the running card to failed.
    const instructions = "Do research.";
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Go",
      },
      {
        seq: 2,
        eventId: "t1",
        conversationId: "c1",
        createdAt: 2,
        kind: "tool_call",
        toolCallId: "tool-fail",
        title: "Subagent Doomed research",
        toolKind: "subagent",
        status: "in_progress",
        detail: "{}",
        raw: {
          id: "tool-fail",
          name: "subagent",
          arguments: { title: "Doomed research", instructions },
        },
      },
      {
        seq: 3,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 3,
        kind: "subagent",
        subagentId: "tool-fail",
        title: "Doomed research",
        status: "running",
        transcript: [
          {
            seq: 0,
            eventId: "st-u",
            conversationId: "c1",
            createdAt: 3,
            kind: "user_message",
            messageId: "sm1",
            content: instructions,
          },
        ],
        recentActivity: instructions,
      },
      {
        seq: 4,
        eventId: "t2",
        conversationId: "c1",
        createdAt: 4,
        kind: "tool_call_update",
        toolCallId: "tool-fail",
        title: "Subagent Doomed research",
        toolKind: "subagent",
        status: "failed",
        detail: "Provider exploded.",
        raw: {
          request: {
            id: "tool-fail",
            name: "subagent",
            arguments: { title: "Doomed research", instructions },
          },
          error: "Provider exploded.",
        },
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });

    const cards = messages.filter((message) => message.type === "subagent");
    assert.equal(cards.length, 1, `expected one subagent card, got ${cards.length}`);
    assert.equal(cards[0]!.subagentStatus, "failed");
    assert.equal(cards[0]!.subagentComplete, true);
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
