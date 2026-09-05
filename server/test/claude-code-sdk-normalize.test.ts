import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeStreamedTextReconciler,
  ClaudeTaskPlanTracker,
  claudeAnswersFromSubmission,
  claudeSlashCommandsFromSdk,
  claudeToolUseToAgentEvent,
  classifyClaudeStreamEvent,
  describeClaudeAssistantError,
  describeClaudeResultFailure,
  describeClaudeSystemEvent,
  formatClaudeUsageDetail,
  parseClaudeAskUserQuestion,
  parseClaudeTaskEvent,
  permissionCategoryForClaudeTool,
  planEntriesFromClaudeToolPayload,
  textDeltaFromClaudeStreamEvent,
  textFromClaudeAssistantMessage,
  thinkingTextFromClaudeAssistantMessage,
  toolResultFromClaudeUserMessage,
  toolUsesFromClaudeAssistantMessage,
  usageFromClaudeResult,
} from "../src/lib/agents/claude-code-sdk-normalize.js";

test("Claude assistant text, thinking, and tool_use blocks normalize", () => {
  const message = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Hello " },
        { type: "thinking", thinking: "Reasoning" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { path: "src/app.ts" },
        },
      ],
    },
  };
  assert.equal(textFromClaudeAssistantMessage(message), "Hello ");
  assert.equal(thinkingTextFromClaudeAssistantMessage(message), "Reasoning");
  assert.deepEqual(toolUsesFromClaudeAssistantMessage(message), [
    { id: "toolu_1", name: "Read", input: { path: "src/app.ts" } },
  ]);
});

test("Claude stream text deltas normalize", () => {
  assert.equal(
    textDeltaFromClaudeStreamEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "chunk" },
      },
    }),
    "chunk"
  );
});

test("Claude tool_use and tool_result map to OpenCursor tool events", () => {
  const call = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e1",
    status: "in_progress",
    tool: { id: "toolu_1", name: "Bash", input: { command: "npm test" } },
  });
  assert.equal(call.kind, "tool_call");
  assert.equal(call.toolKind, "terminal");
  assert.equal(call.title, "Ran npm test");

  const readCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e2",
    status: "in_progress",
    tool: { id: "toolu_2", name: "Read", input: { file_path: "server/package.json" } },
  });
  assert.equal(readCall.toolKind, "read");
  assert.equal(readCall.title, "Read package.json");

  const results = toolResultFromClaudeUserMessage({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "ok",
          is_error: false,
        },
      ],
    },
  });
  assert.deepEqual(results, [{ id: "toolu_1", result: "ok", isError: false }]);
});

test("Claude TodoWrite payloads mirror into plan entries", () => {
  const entries = planEntriesFromClaudeToolPayload({
    todos: [
      { id: "a", content: "Read files", status: "completed" },
      { id: "b", content: "Patch bug", status: "in_progress", priority: "high" },
      { id: "c", content: "Wait on credentials", status: "blocked" },
    ],
  });
  assert.deepEqual(entries, [
    { id: "a", content: "Read files", status: "completed", priority: undefined },
    { id: "b", content: "Patch bug", status: "in_progress", priority: "high" },
    { id: "c", content: "Wait on credentials", status: "blocked", priority: undefined },
  ]);
});

test("Claude Grep, WebSearch, and Edit tools normalize to OpenCursor tool kinds", () => {
  const grepCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e3",
    status: "in_progress",
    tool: { id: "toolu_3", name: "Grep", input: { pattern: "normalize", path: "src" } },
  });
  assert.equal(grepCall.toolKind, "grep");
  assert.equal(grepCall.title, 'Grep "normalize"');

  const webCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e4",
    status: "in_progress",
    tool: { id: "toolu_4", name: "WebSearch", input: { query: "anthropic api" } },
  });
  assert.equal(webCall.toolKind, "search_web");
  assert.equal(webCall.title, "Web · anthropic api");

  const editCall = claudeToolUseToAgentEvent({
    conversationId: "c1",
    eventId: "e5",
    status: "in_progress",
    tool: { id: "toolu_5", name: "Edit", input: { file_path: "src/app.ts" } },
  });
  assert.equal(editCall.toolKind, "edit");
  assert.equal(editCall.title, "Update app.ts");
});

test("Claude 2.1 task-list, subagent, question, and plan tools get explicit kinds and titles", () => {
  const make = (name: string, input: unknown) =>
    claudeToolUseToAgentEvent({
      conversationId: "c1",
      eventId: `e-${name}`,
      status: "in_progress",
      tool: { id: `toolu_${name}`, name, input },
    });
  const create = make("TaskCreate", { subject: "Write tests", description: "Cover the parser" });
  assert.equal(create.toolKind, "todo");
  assert.equal(create.title, "Add task · Write tests");
  assert.equal(create.detail, "Cover the parser");
  const update = make("TaskUpdate", { taskId: "3", status: "completed" });
  assert.equal(update.toolKind, "todo");
  assert.equal(update.title, "Complete task #3");
  assert.equal(make("Agent", { description: "Find configs", prompt: "..." }).title, "Subagent · Find configs");
  assert.equal(make("Agent", { description: "Find configs", prompt: "..." }).toolKind, "task");
  assert.equal(make("AskUserQuestion", { questions: [] }).toolKind, "question");
  assert.equal(make("ExitPlanMode", {}).title, "Exit plan mode");
  assert.equal(make("Skill", { skill: "deep-research" }).title, "Skill · deep-research");
  assert.equal(make("Workflow", { name: "spec" }).title, "Workflow · spec");
  assert.equal(make("NotebookEdit", { notebook_path: "/tmp/analysis.ipynb" }).toolKind, "edit");
  assert.equal(make("WebFetch", { url: "https://example.com" }).toolKind, "fetch");
  assert.equal(make("mcp__github__list_issues", { repo: "x" }).toolKind, "mcp");
  assert.equal(permissionCategoryForClaudeTool("Bash"), "terminal");
  assert.equal(permissionCategoryForClaudeTool("Edit"), "editFile");
  assert.equal(permissionCategoryForClaudeTool("mcp__github__list_issues"), "mcpCall");
  assert.equal(permissionCategoryForClaudeTool("Read"), undefined);
});

test("ClaudeTaskPlanTracker folds TaskCreate/TaskUpdate/TaskList traffic into one plan", () => {
  const tracker = new ClaudeTaskPlanTracker();
  assert.equal(tracker.noteToolUse({ id: "t1", name: "TaskCreate", input: { subject: "A", description: "a" } }), false);
  assert.equal(
    tracker.noteToolResult({ id: "t1", name: "TaskCreate", result: "Task #1 created successfully: A", structuredResult: { task: { id: "1", subject: "A" } } }),
    true
  );
  assert.equal(tracker.noteToolUse({ id: "t2", name: "TaskCreate", input: { subject: "B", description: "b" } }), false);
  assert.equal(tracker.noteToolResult({ id: "t2", name: "TaskCreate", result: "Task #2 created successfully: B" }), true, "id parsed from text when no structured result");
  assert.equal(tracker.noteToolUse({ id: "t3", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }), true);
  assert.equal(tracker.noteToolUse({ id: "t4", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }), false, "no-op updates do not re-emit");
  assert.deepEqual(
    tracker.entries().map((entry) => `${entry.id}:${entry.status}:${entry.content}`),
    ["1:in_progress:A", "2:pending:B"]
  );
  assert.equal(
    tracker.noteToolResult({
      id: "t5",
      name: "TaskList",
      structuredResult: {
        tasks: [
          { id: "1", subject: "A", status: "completed", blockedBy: [] },
          { id: "3", subject: "C", status: "pending", blockedBy: ["1"] },
        ],
      },
    }),
    true
  );
  assert.deepEqual(
    tracker.entries().map((entry) => `${entry.id}:${entry.status}:${entry.content}`),
    ["1:completed:A", "3:blocked:C"],
    "TaskList is authoritative: removed tasks drop out, blocked tasks show as blocked"
  );
  assert.equal(tracker.noteToolUse({ id: "t6", name: "TaskUpdate", input: { taskId: "3", status: "deleted" } }), true);
  assert.equal(tracker.size, 1);
  assert.equal(tracker.noteToolUse({ id: "t7", name: "TaskUpdate", input: { taskId: "9", status: "completed" } }), true);
  assert.equal(tracker.entries().find((entry) => entry.id === "9")?.content, "Task #9", "unknown tasks from resumed sessions get a placeholder");
  const legacy = new ClaudeTaskPlanTracker();
  assert.equal(legacy.noteToolUse({ id: "t8", name: "TodoWrite", input: { todos: [{ content: "Old", status: "completed", activeForm: "x" }] } }), true);
  assert.equal(legacy.entries()[0]?.status, "completed");
});

test("AskUserQuestion payloads parse into steps and Cesium submissions map back to answers", () => {
  const parsed = parseClaudeAskUserQuestion({
    questions: [
      { question: "Tabs or spaces?", header: "Indent", multiSelect: false, options: [{ label: "Tabs", description: "" }, { label: "Spaces", description: "" }] },
      { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Lint", description: "" }, { label: "Format", description: "" }] },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.prompt, "2 questions from Claude");
  assert.equal(parsed.steps[1]?.allowMultiple, true);
  assert.deepEqual(parsed.steps[0]?.options.map((option) => option.label), ["Tabs", "Spaces"]);
  assert.deepEqual(
    claudeAnswersFromSubmission(parsed.steps, "Tabs or spaces?: Tabs\nWhich features?: Lint, Format"),
    { "Tabs or spaces?": "Tabs", "Which features?": "Lint, Format" }
  );
  assert.deepEqual(
    claudeAnswersFromSubmission(parsed.steps, "Question 1: Spaces\nQuestion 2: Lint"),
    { "Tabs or spaces?": "Spaces", "Which features?": "Lint" },
    "generic numbered labels map by position"
  );
  const single = parseClaudeAskUserQuestion({ questions: [{ question: "Deploy now?", header: "Deploy", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] });
  assert.ok(single);
  assert.equal(single.prompt, "Deploy now?");
  assert.deepEqual(claudeAnswersFromSubmission(single.steps, "Not yet, wait for QA"), { "Deploy now?": "Not yet, wait for QA" }, "free text lands on the only question");
  assert.equal(parseClaudeAskUserQuestion({ questions: [] }), null);
});

test("stream reconciler avoids duplicating streamed text but emits unstreamed remainders", () => {
  const full = new ClaudeStreamedTextReconciler();
  full.append("Hello ");
  full.append("world");
  assert.equal(full.reconcile("Hello world"), "");
  const partial = new ClaudeStreamedTextReconciler();
  partial.append("Hello");
  assert.equal(partial.reconcile("Hello world"), " world");
  const none = new ClaudeStreamedTextReconciler();
  assert.equal(none.reconcile("Hello world"), "Hello world");
  const twoBlocks = new ClaudeStreamedTextReconciler();
  twoBlocks.append("First.");
  twoBlocks.append("Second.");
  assert.equal(twoBlocks.reconcile("First."), "");
  assert.equal(twoBlocks.reconcile("Second."), "");
  const divergent = new ClaudeStreamedTextReconciler();
  divergent.append("Refused");
  assert.equal(divergent.reconcile("Rewritten answer"), "Rewritten answer");
});

test("stream events classify message boundaries and tool input deltas", () => {
  assert.deepEqual(
    classifyClaudeStreamEvent({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } }),
    { kind: "message_start", apiMessageId: "msg_1" }
  );
  assert.deepEqual(classifyClaudeStreamEvent({ type: "stream_event", event: { type: "message_stop" } }), { kind: "message_stop" });
  assert.deepEqual(
    classifyClaudeStreamEvent({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read", id: "toolu_1" } } }),
    { kind: "block_start", blockType: "tool_use", toolName: "Read", toolUseId: "toolu_1" }
  );
  assert.deepEqual(
    classifyClaudeStreamEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"fi" } } }),
    { kind: "tool_input", partialJson: "{\"fi" }
  );
  assert.deepEqual(
    classifyClaudeStreamEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } } }),
    { kind: "thinking", text: "hm" }
  );
});

test("task lifecycle messages parse the task_updated patch envelope", () => {
  const started = parseClaudeTaskEvent({
    subtype: "task_started",
    task_id: "t1",
    tool_use_id: "toolu_1",
    description: "Explore",
    subagent_type: "Explore",
    task_type: "local_agent",
  });
  assert.equal(started?.subagentType, "Explore");
  assert.equal(started?.taskType, "local_agent");
  const updated = parseClaudeTaskEvent({
    subtype: "task_updated",
    task_id: "t1",
    patch: { status: "failed", error: "Agent terminated early", end_time: 1 },
  });
  assert.equal(updated?.status, "failed");
  assert.equal(updated?.error, "Agent terminated early");
  const workflow = parseClaudeTaskEvent({
    subtype: "task_started",
    task_id: "w1",
    task_type: "local_workflow",
    workflow_name: "spec",
    description: "Run spec workflow",
  });
  assert.equal(workflow?.workflowName, "spec");
  assert.equal(parseClaudeTaskEvent({ subtype: "init" }), null);
});

test("system subtypes and result failures render readable text", () => {
  assert.match(
    describeClaudeSystemEvent({ subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 200 } }).text,
    /Automatic context compaction \(1,000 tokens → 200 tokens\)/
  );
  const denied = describeClaudeSystemEvent({ subtype: "permission_denied", tool_name: "Write", decision_reason: "deny rule", message: "no" });
  assert.equal(denied.level, "warning");
  assert.match(denied.text, /Write was auto-denied: deny rule/);
  assert.equal(describeClaudeSystemEvent({ subtype: "thinking_tokens" }).visible, false);
  assert.equal(describeClaudeSystemEvent({ subtype: "informational", content: "x", level: "info" }).visible, false);
  assert.equal(describeClaudeSystemEvent({ subtype: "informational", content: "x", level: "warning" }).visible, true);
  assert.match(describeClaudeSystemEvent({ subtype: "hook_response", hook_name: "lint", outcome: "error", stderr: "boom" }).text, /Hook lint error: boom/);
  assert.match(describeClaudeSystemEvent({ subtype: "brand_new_subtype" }).text, /brand new subtype/);
  assert.match(
    describeClaudeResultFailure({ subtype: "error_max_budget_usd", errors: [], terminal_reason: "budget_exhausted" }),
    /USD budget was exhausted.*token budget was exhausted/
  );
  assert.match(
    describeClaudeResultFailure({ subtype: "error_during_execution", errors: ["EACCES: permission denied"] }),
    /error during execution\. EACCES/
  );
});

test("result usage summarizes tokens, cost, and the primary model context window", () => {
  const usage = usageFromClaudeResult({
    total_cost_usd: 0.0456,
    duration_ms: 12_300,
    num_turns: 3,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 },
    modelUsage: {
      "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 },
      "kimi-k3": { inputTokens: 990, outputTokens: 195, cacheReadInputTokens: 5000, cacheCreationInputTokens: 100, contextWindow: 262144 },
    },
  });
  assert.equal(usage.primaryModel, "kimi-k3");
  assert.equal(usage.contextWindow, 262144);
  assert.equal(usage.cacheReadTokens, 5000);
  assert.equal(formatClaudeUsageDetail(usage), "6,100 in / 200 out tokens · ~$0.0456 · 12.3s · 3 model turns");
  assert.equal(formatClaudeUsageDetail(usageFromClaudeResult({})), "");
});

test("slash command lists dedupe, hide internal commands, and keep hints", () => {
  assert.deepEqual(
    claudeSlashCommandsFromSdk([
      { name: "compact", description: "Compact", argumentHint: "" },
      { name: "__remote-workflow", description: "internal" },
      { name: "review", description: "Review", argumentHint: "<pr>" },
      { name: "compact", description: "dupe" },
      "clear",
    ]),
    [
      { name: "compact", description: "Compact" },
      { name: "review", description: "Review", inputHint: "<pr>" },
      { name: "clear" },
    ]
  );
});

test("unknown API errors are reclassified from their text", () => {
  assert.match(
    describeClaudeAssistantError("unknown", "API Error: 400 Model 'claude-x' not found in routing configuration."),
    /^The selected model is not available on this Claude endpoint\. \(400 Model 'claude-x' not found/
  );
  assert.match(describeClaudeAssistantError("unknown", "API Error: 401 invalid x-api-key"), /^Authentication failed/);
  assert.match(describeClaudeAssistantError("unknown", "API Error: 524 Cloudflare timeout"), /^The Claude API returned a server error/);
  assert.match(describeClaudeAssistantError("unknown", "API Error: 429 Too Many Requests"), /^Claude API rate limit reached/);
  assert.match(describeClaudeAssistantError("rate_limit", ""), /^Claude API rate limit reached\.$/);
  assert.match(describeClaudeAssistantError("authentication_failed", "API Error: 401"), /^Authentication failed.*\(401\)$/);
});
