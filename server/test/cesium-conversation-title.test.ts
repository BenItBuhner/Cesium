import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCesiumBaseSystemPrompt } from "@cesium/core/mcp";
import { buildCesiumTurnReminder } from "../src/lib/agents/cesium-reminders.js";
import {
  applyConversationTitleAction,
  formatConversationTitleReminderLine,
  normalizeConversationTitle,
  parseConversationTitleToolArgs,
} from "../src/lib/agents/cesium/cesium-conversation-tools.js";
import {
  resolveCesiumTools,
  toolKind,
  toolTitle,
} from "../src/lib/agents/cesium/cesium-tools.js";

test("conversation_title is a first-party history tool advertised to Code and Work", () => {
  const harness = resolveCesiumTools();
  const definition = harness.tools.find((tool) => tool.name === "conversation_title");
  assert.ok(definition);
  assert.match(definition.description, /only when the user/i);
  assert.deepEqual((definition.parameters as { properties?: { action?: { enum?: string[] } } }).properties?.action?.enum, [
    "read",
    "rename",
  ]);
  assert.equal(definition.requiresPermission, undefined);
  assert.equal(toolKind("conversation_title"), "search");
  assert.equal(toolTitle("conversation_title", { action: "read" }), "Read conversation title");
  assert.equal(
    toolTitle("conversation_title", { action: "rename", title: "Fix login retry" }),
    "Rename conversation to Fix login retry"
  );
});

test("parseConversationTitleToolArgs reads, renames, and toggles follow", () => {
  assert.deepEqual(parseConversationTitleToolArgs({}), { action: "read" });
  assert.deepEqual(parseConversationTitleToolArgs({ action: "get" }), { action: "read" });
  assert.deepEqual(parseConversationTitleToolArgs({ title: "Ship the rail" }), {
    action: "rename",
    title: "Ship the rail",
  });
  assert.deepEqual(
    parseConversationTitleToolArgs({ action: "rename", title: "Ship the rail", follow: "on" }),
    { action: "rename", title: "Ship the rail", follow: true }
  );
  assert.deepEqual(parseConversationTitleToolArgs({ action: "read", follow: false }), {
    action: "read",
    follow: false,
  });
  assert.throws(
    () => parseConversationTitleToolArgs({ action: "rename" }),
    /title is required/
  );
  assert.throws(
    () => parseConversationTitleToolArgs({ action: "explode" }),
    /must be "read" or "rename"/
  );
});

test("applyConversationTitleAction renames, caps length, and persists follow without renaming", () => {
  assert.equal(normalizeConversationTitle("  two   words  "), "two words");
  assert.equal(normalizeConversationTitle("   "), null);
  const long = "x".repeat(80);
  const capped = normalizeConversationTitle(long);
  assert.ok(capped);
  assert.equal(capped.length, 44);
  assert.ok(capped.endsWith("..."));

  const renamed = applyConversationTitleAction({
    currentTitle: "New chat",
    currentFollow: false,
    action: "rename",
    title: "Fix the login retry",
  });
  assert.equal(renamed.changed, true);
  assert.equal(renamed.nextTitle, "Fix the login retry");
  assert.equal(renamed.nextFollow, false);
  assert.match(renamed.result, /Renamed conversation from "New chat" to "Fix the login retry"/);

  const followOnly = applyConversationTitleAction({
    currentTitle: "Fix the login retry",
    currentFollow: false,
    action: "read",
    follow: true,
  });
  assert.equal(followOnly.changed, true);
  assert.equal(followOnly.nextTitle, "Fix the login retry");
  assert.equal(followOnly.nextFollow, true);
  assert.match(followOnly.result, /follow is on/);

  const noop = applyConversationTitleAction({
    currentTitle: "Fix the login retry",
    currentFollow: true,
    action: "read",
  });
  assert.equal(noop.changed, false);
  assert.match(noop.result, /Conversation title: "Fix the login retry"/);
});

test("mode reminder shows the current title and follow hint only when armed", () => {
  assert.equal(
    formatConversationTitleReminderLine("Fix login retry", false),
    `- Conversation title: "Fix login retry"`
  );
  assert.match(
    formatConversationTitleReminderLine("Fix login retry", true),
    /follow on — update via conversation_title/
  );

  const idle = buildCesiumTurnReminder({
    modelName: "kimi-k3",
    workspaceRoot: "/workspace",
    dateLabel: "Thursday",
    gitSummary: "main clean",
    mcpSummaries: [],
    conversationTitle: "Fix login retry",
    conversationTitleFollow: false,
  });
  assert.match(idle, /Conversation title: "Fix login retry"/);
  assert.doesNotMatch(idle, /follow on/);

  const following = buildCesiumTurnReminder({
    modelName: "kimi-k3",
    workspaceRoot: "/workspace",
    dateLabel: "Thursday",
    gitSummary: "main clean",
    mcpSummaries: [],
    conversationTitle: "Fix login retry",
    conversationTitleFollow: true,
  });
  assert.match(following, /follow on — update via conversation_title/);
});

test("the system prompt mentions conversation_title without making it the job", () => {
  const prompt = buildCesiumBaseSystemPrompt();
  assert.match(prompt, /conversation_title/);
  assert.match(prompt, /Do not rename unprompted/);
});
