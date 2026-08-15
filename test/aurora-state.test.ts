import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveAuroraConversationState } from "../src/lib/aurora-state.ts";

describe("aurora conversation state", () => {
  test("prefers working over every quieter state", () => {
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: true,
        status: "running",
        busy: true,
        typing: true,
        recentlyCompleted: true,
        hasCompletionError: false,
      }),
      "working"
    );
  });

  test("maps permission and question waits", () => {
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "awaiting_permission",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "awaiting"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "awaiting_question",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "awaiting"
    );
  });

  test("surfaces failure, pause, and cancel", () => {
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "failed",
        busy: false,
        typing: false,
        recentlyCompleted: true,
        hasCompletionError: false,
      }),
      "failed"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "idle",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: true,
      }),
      "failed"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "paused",
        busy: false,
        typing: true,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "paused"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "interrupted",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "cancelled"
    );
  });

  test("holds completed, then typing, then new, then idle", () => {
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: true,
        status: "idle",
        busy: false,
        typing: false,
        recentlyCompleted: true,
        hasCompletionError: false,
      }),
      "completed"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: true,
        status: "idle",
        busy: false,
        typing: true,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "typing"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: true,
        status: "idle",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "new"
    );
    assert.equal(
      resolveAuroraConversationState({
        isNewChat: false,
        status: "idle",
        busy: false,
        typing: false,
        recentlyCompleted: false,
        hasCompletionError: false,
      }),
      "idle"
    );
  });
});
