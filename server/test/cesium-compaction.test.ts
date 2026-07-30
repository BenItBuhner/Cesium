import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolResultMicrocompaction,
  buildHeuristicLedgerBody,
  buildLedgerSystemPrompt,
  CESIUM_COMPACTION_ENGINE_ID,
  CESIUM_COMPACTION_PIN_MARKER,
  CESIUM_LEDGER_SECTIONS,
  chooseCompactionSplit,
  collectCompactionPins,
  compactionWarningBucket,
  emptyCesiumLedger,
  latestLedgerFromEvents,
  looksLikeLedgerBody,
  mergeLedgerBodies,
  renderEventsForCompaction,
  renderLedgerForContext,
  resolveCompactionBudgets,
  runCesiumCompactionPipeline,
  updateUserQuoteArchive,
} from "../src/lib/agents/cesium/cesium-compaction.js";
import { normalizeEventsToHistory } from "../src/lib/agents/cesium/cesium-history.js";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

let seqCounter = 0;

function userEvent(content: string, overrides: Partial<Record<string, unknown>> = {}): AgentStoredEvent {
  seqCounter += 1;
  return {
    seq: seqCounter,
    eventId: `u-${seqCounter}`,
    conversationId: "conv-1",
    createdAt: seqCounter,
    kind: "user_message",
    messageId: `m-${seqCounter}`,
    content,
    ...overrides,
  } as AgentStoredEvent;
}

function assistantEvents(text: string): AgentStoredEvent[] {
  seqCounter += 1;
  const chunkSeq = seqCounter;
  seqCounter += 1;
  const endSeq = seqCounter;
  const messageId = `am-${chunkSeq}`;
  return [
    {
      seq: chunkSeq,
      eventId: `ac-${chunkSeq}`,
      conversationId: "conv-1",
      createdAt: chunkSeq,
      kind: "assistant_message_chunk",
      messageId,
      text,
    },
    {
      seq: endSeq,
      eventId: `ae-${endSeq}`,
      conversationId: "conv-1",
      createdAt: endSeq,
      kind: "assistant_message_end",
      messageId,
      stopReason: "end_turn",
    },
  ];
}

function toolEvents(name: string, result: string, status: "completed" | "failed" = "completed"): AgentStoredEvent[] {
  seqCounter += 1;
  const callSeq = seqCounter;
  seqCounter += 1;
  const updateSeq = seqCounter;
  const toolCallId = `tc-${callSeq}`;
  return [
    {
      seq: callSeq,
      eventId: `tcall-${callSeq}`,
      conversationId: "conv-1",
      createdAt: callSeq,
      kind: "tool_call",
      toolCallId,
      title: `${name} something`,
      toolKind: "execute",
      status: "running",
      raw: { request: { name, arguments: { path: "/tmp/example.ts" } } },
    },
    {
      seq: updateSeq,
      eventId: `tup-${updateSeq}`,
      conversationId: "conv-1",
      createdAt: updateSeq,
      kind: "tool_call_update",
      toolCallId,
      title: `${name} something`,
      toolKind: "execute",
      status,
      detail: result,
    },
  ];
}

function subagentEvent(id: string, title: string, activity: string): AgentStoredEvent {
  seqCounter += 1;
  return {
    seq: seqCounter,
    eventId: `sub-${seqCounter}`,
    conversationId: "conv-1",
    createdAt: seqCounter,
    kind: "subagent",
    subagentId: id,
    title,
    status: "completed",
    transcript: [],
    recentActivity: activity,
  };
}

function pinEvent(text: string): AgentStoredEvent {
  seqCounter += 1;
  return {
    seq: seqCounter,
    eventId: `pin-${seqCounter}`,
    conversationId: "conv-1",
    createdAt: seqCounter,
    kind: "system_reminder",
    reminderId: `pin-${seqCounter}`,
    reason: "compaction",
    text,
    raw: { marker: CESIUM_COMPACTION_PIN_MARKER },
  };
}

function resetSeq(): void {
  seqCounter = 0;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test("resolveCompactionBudgets maps intensity to retention", () => {
  const gentle = resolveCompactionBudgets({
    contextWindowTokens: 100_000,
    intensity: 0,
    thresholdRatio: 0.82,
  });
  const aggressive = resolveCompactionBudgets({
    contextWindowTokens: 100_000,
    intensity: 1,
    thresholdRatio: 0.82,
  });
  assert.equal(gentle.triggerTokens, 82_000);
  assert.ok(gentle.targetTokens > aggressive.targetTokens);
  assert.ok(gentle.tailBudgetTokens > aggressive.tailBudgetTokens);
  assert.ok(gentle.toolResultProtectTokens > aggressive.toolResultProtectTokens);
  assert.ok(gentle.userQuoteCapChars > aggressive.userQuoteCapChars);
  // Target must always stay below trigger so compaction actually frees space.
  assert.ok(gentle.targetTokens < gentle.triggerTokens);
  assert.ok(aggressive.targetTokens < aggressive.triggerTokens);
  assert.ok(gentle.warnTokens < gentle.triggerTokens);
});

test("resolveCompactionBudgets keeps target under trigger for low thresholds", () => {
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 32_000,
    intensity: 0,
    thresholdRatio: 0.5,
  });
  assert.ok(budgets.targetTokens < budgets.triggerTokens);
});

// ---------------------------------------------------------------------------
// Microcompaction
// ---------------------------------------------------------------------------

test("applyToolResultMicrocompaction stubs old bulky results and protects recent ones", () => {
  resetSeq();
  const bulky = "x".repeat(10_000);
  const events: AgentStoredEvent[] = [
    userEvent("start"),
    ...toolEvents("terminal", bulky),
    ...toolEvents("terminal", bulky),
    ...toolEvents("terminal", bulky),
    userEvent("continue"),
  ];
  // Protect ~1 result's worth of tokens: the oldest two get stubbed.
  const result = applyToolResultMicrocompaction(events, { protectTokens: 3_000 });
  assert.equal(result.prunedToolResults, 2);
  assert.ok(result.savedChars > 15_000);
  const details = result.events
    .filter((event) => event.kind === "tool_call_update")
    .map((event) => (event.kind === "tool_call_update" ? event.detail ?? "" : ""));
  assert.ok(details[0]!.includes("pruned during context compaction"));
  assert.ok(details[0]!.includes("search_history"));
  assert.ok(details[1]!.includes("pruned during context compaction"));
  assert.equal(details[2], bulky);
  // Original array untouched (view transform, storage stays verbatim).
  const originalDetails = events.filter((event) => event.kind === "tool_call_update");
  assert.ok(
    originalDetails.every(
      (event) => event.kind === "tool_call_update" && event.detail === bulky
    )
  );
});

test("applyToolResultMicrocompaction leaves small results alone", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    ...toolEvents("grep", "short result"),
    ...toolEvents("terminal", "y".repeat(9_000)),
  ];
  const result = applyToolResultMicrocompaction(events, { protectTokens: 100 });
  const details = result.events
    .filter((event) => event.kind === "tool_call_update")
    .map((event) => (event.kind === "tool_call_update" ? event.detail ?? "" : ""));
  assert.equal(details[0], "short result");
});

// ---------------------------------------------------------------------------
// Split selection
// ---------------------------------------------------------------------------

test("chooseCompactionSplit cuts at a user boundary and keeps the last turn", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    events.push(userEvent(`turn ${turn}: ${"detail ".repeat(200)}`));
    events.push(...assistantEvents(`answer ${turn}: ${"reply ".repeat(200)}`));
  }
  const split = chooseCompactionSplit(events, { tailBudgetTokens: 1_200 });
  assert.ok(split.spanEvents.length > 0);
  const firstRetained = split.retainedEvents[0]!;
  assert.equal(firstRetained.kind, "user_message");
  // The final user turn must be retained.
  const lastUser = [...events].reverse().find((event) => event.kind === "user_message")!;
  assert.ok(split.retainedEvents.some((event) => event.seq === lastUser.seq));
  // No overlap, no loss.
  assert.equal(split.spanEvents.length + split.retainedEvents.length, events.length);
});

test("chooseCompactionSplit refuses to evict when only one user turn exists", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    userEvent("only turn"),
    ...assistantEvents("massive ".repeat(5_000)),
  ];
  const split = chooseCompactionSplit(events, { tailBudgetTokens: 10 });
  assert.equal(split.spanEvents.length, 0);
});

// ---------------------------------------------------------------------------
// User quote archive
// ---------------------------------------------------------------------------

test("updateUserQuoteArchive keeps quotes verbatim then gists oldest under pressure", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    userEvent("Use tabs, never spaces, in the polybot repo."),
    userEvent("The API key lives in .env.polymarket — never commit it."),
  ];
  const quotes = updateUserQuoteArchive([], events, {
    userQuoteCapChars: 2_000,
    userArchiveBudgetTokens: 10_000,
  });
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0]!.text, "Use tabs, never spaces, in the polybot repo.");

  // Now force gisting with a tiny budget.
  resetSeq();
  const bigEvents: AgentStoredEvent[] = [
    userEvent("A".repeat(1_000)),
    userEvent("B".repeat(1_000)),
    userEvent("C".repeat(1_000)),
  ];
  const gisted = updateUserQuoteArchive([], bigEvents, {
    userQuoteCapChars: 2_000,
    userArchiveBudgetTokens: 300, // 1200 chars
  });
  assert.ok(gisted[0]!.gist);
  assert.ok(gisted[0]!.text.includes("full text at s"));
  // Newest quote stays verbatim longest.
  assert.ok(!gisted[2]!.gist || gisted[2]!.text.length > 100);
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test("collectCompactionPins filters by marker and keeps newest within budget", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    pinEvent("pin one"),
    {
      seq: 999,
      eventId: "warn-1",
      conversationId: "conv-1",
      createdAt: 999,
      kind: "system_reminder",
      reminderId: "warn-1",
      reason: "compaction",
      text: "warning text, not a pin",
      raw: { marker: "compaction_warning", bucket: 75 },
    },
    pinEvent("pin two"),
  ];
  const pins = collectCompactionPins(events, { budgetChars: 10_000 });
  assert.deepEqual(
    pins.map((pin) => pin.text),
    ["pin one", "pin two"]
  );
  const tight = collectCompactionPins(events, { budgetChars: 8 });
  assert.deepEqual(
    tight.map((pin) => pin.text),
    ["pin two"]
  );
});

// ---------------------------------------------------------------------------
// Span rendering
// ---------------------------------------------------------------------------

test("renderEventsForCompaction emits seq-tagged lines with tool names and failures", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    userEvent("please fix the bug"),
    ...assistantEvents("looking into it"),
    ...toolEvents("terminal", "command output here"),
    ...toolEvents("edit_file", "Error: permission denied on /etc/hosts", "failed"),
    subagentEvent("sub-42", "Research flaky test", "Found the root cause in retry logic"),
  ];
  const text = renderEventsForCompaction(events);
  assert.ok(text.includes("[s1] USER: please fix the bug"));
  assert.ok(/\[s2(-s3)?\] ASSISTANT: looking into it/.test(text));
  assert.ok(text.includes("TOOL-RESULT terminal"));
  assert.ok(text.includes("TOOL-FAILED edit_file"));
  assert.ok(text.includes("permission denied"));
  assert.ok(text.includes("SUBAGENT sub-42"));
});

// ---------------------------------------------------------------------------
// Ledger prompts & parsing
// ---------------------------------------------------------------------------

test("ledger system prompt covers all sections and looksLikeLedgerBody validates", () => {
  const prompt = buildLedgerSystemPrompt({ ledgerBudgetTokens: 4_000 });
  for (const section of CESIUM_LEDGER_SECTIONS) {
    assert.ok(prompt.includes(`## ${section}`), `missing section ${section}`);
  }
  const validBody = CESIUM_LEDGER_SECTIONS.map((section) => `## ${section}\n- entry`).join("\n");
  assert.ok(looksLikeLedgerBody(validBody));
  assert.ok(!looksLikeLedgerBody("Just some freeform text about the conversation."));
});

// ---------------------------------------------------------------------------
// Heuristic fallback
// ---------------------------------------------------------------------------

test("buildHeuristicLedgerBody extracts failures, subagents, artifacts verbatim", () => {
  resetSeq();
  const events: AgentStoredEvent[] = [
    userEvent("Deploy polybot with the kelly-sizing branch"),
    ...toolEvents("write_file", "created"),
    ...toolEvents("terminal", "Error: ECONNREFUSED 127.0.0.1:5432", "failed"),
    subagentEvent("sub-7", "Backtest runner", "Sharpe 1.34 over 90d"),
  ];
  const body = buildHeuristicLedgerBody({ previousBody: "", spanEvents: events });
  assert.ok(looksLikeLedgerBody(body));
  assert.ok(body.includes("/tmp/example.ts"));
  assert.ok(body.includes("ECONNREFUSED"));
  assert.ok(body.includes("sub-7"));
});

test("mergeLedgerBodies dedupes section-wise and stays bounded across generations", () => {
  resetSeq();
  const spanA: AgentStoredEvent[] = [
    ...toolEvents("terminal", "Error: alpha exploded", "failed"),
    subagentEvent("sub-a", "Task A", "done A"),
  ];
  const spanB: AgentStoredEvent[] = [
    ...toolEvents("terminal", "Error: beta exploded", "failed"),
    subagentEvent("sub-b", "Task B", "done B"),
  ];
  const genOne = buildHeuristicLedgerBody({ previousBody: "", spanEvents: spanA });
  const genTwo = buildHeuristicLedgerBody({ previousBody: genOne, spanEvents: spanB });
  const genThree = buildHeuristicLedgerBody({ previousBody: genTwo, spanEvents: spanB });
  // Both generations' knowledge survives.
  assert.ok(genTwo.includes("alpha exploded"));
  assert.ok(genTwo.includes("beta exploded"));
  assert.ok(genTwo.includes("sub-a"));
  assert.ok(genTwo.includes("sub-b"));
  // Re-merging identical content must not grow the body (dedupe works).
  assert.ok(genThree.length <= genTwo.length + 32);
  // Exactly one header per section (no stacked bodies).
  const missionCount = (genThree.match(/## MISSION/g) ?? []).length;
  assert.equal(missionCount, 1);
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function buildLongConversation(turns: number): AgentStoredEvent[] {
  resetSeq();
  const events: AgentStoredEvent[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    events.push(userEvent(`turn ${turn}: work on module ${turn} ${"ctx ".repeat(120)}`));
    events.push(...toolEvents("terminal", `output of build ${turn}\n${"log ".repeat(700)}`));
    events.push(...assistantEvents(`done with module ${turn} ${"summary ".repeat(120)}`));
  }
  return events;
}

test("pipeline noop under trigger", async () => {
  const events = buildLongConversation(2);
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 1_000_000,
    intensity: 0.35,
    thresholdRatio: 0.82,
  });
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: 1_000,
    budgets,
    callModel: null,
  });
  assert.equal(outcome.kind, "noop");
});

test("pipeline microcompacts when stubs alone reach the target", async () => {
  resetSeq();
  const events: AgentStoredEvent[] = [];
  for (let turn = 0; turn < 8; turn += 1) {
    events.push(userEvent(`turn ${turn}`));
    events.push(...toolEvents("terminal", `build ${turn}\n${"log ".repeat(3_000)}`));
    events.push(...assistantEvents(`done ${turn}`));
  }
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 40_000,
    intensity: 1,
    thresholdRatio: 0.5,
  });
  // usedTokens just over the trigger; stubbing old tool outputs frees enough.
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 500,
    budgets,
    callModel: null,
  });
  assert.equal(outcome.kind, "microcompact");
  if (outcome.kind === "microcompact") {
    assert.ok(outcome.stats.prunedToolResults > 0);
    assert.ok(outcome.stats.usedTokensAfter < outcome.stats.usedTokensBefore);
  }
});

test("pipeline compacts into a ledger via the model and preserves user quotes", async () => {
  const events = buildLongConversation(14);
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 24_000,
    intensity: 0.6,
    thresholdRatio: 0.6,
  });
  const calls: Array<{ system: string; user: string }> = [];
  const fakeBody = CESIUM_LEDGER_SECTIONS.map(
    (section) => `## ${section}\n- fake entry [s1]`
  ).join("\n");
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 20_000,
    budgets,
    callModel: async (input) => {
      calls.push(input);
      return input.system.includes("auditing") ? "VERIFIED-OK" : fakeBody;
    },
  });
  assert.equal(outcome.kind, "compacted");
  if (outcome.kind === "compacted") {
    assert.equal(outcome.ledger.generation, 1);
    assert.equal(outcome.ledger.body, fakeBody);
    assert.ok(outcome.ledger.userQuotes.length > 0);
    assert.ok(outcome.ledger.userQuotes[0]!.text.startsWith("turn 0"));
    assert.ok(outcome.stats.usedLlm);
    assert.ok(outcome.stats.spanToSeq > 0);
    assert.ok(outcome.retainedEvents.every((event) => event.seq > outcome.stats.spanToSeq));
    // Update call happened; verification may or may not run depending on span size.
    assert.ok(calls.length >= 1);
    const rendered = renderLedgerForContext(outcome.ledger);
    assert.ok(rendered.includes("<context_ledger>"));
    assert.ok(rendered.includes("USER MESSAGES (VERBATIM"));
  }
});

test("pipeline falls back to heuristic extraction when the model call fails", async () => {
  const events = buildLongConversation(14);
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 24_000,
    intensity: 0.6,
    thresholdRatio: 0.6,
  });
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 20_000,
    budgets,
    callModel: async () => {
      throw new Error("proxy exploded");
    },
  });
  assert.equal(outcome.kind, "compacted");
  if (outcome.kind === "compacted") {
    assert.equal(outcome.stats.usedLlm, false);
    assert.equal(outcome.ledger.heuristic, true);
    assert.ok(looksLikeLedgerBody(outcome.ledger.body));
    assert.equal(outcome.stats.llmError, "proxy exploded");
  }
});

test("pipeline verification pass can revise the ledger", async () => {
  const events = buildLongConversation(20);
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 24_000,
    intensity: 0.6,
    thresholdRatio: 0.6,
  });
  const draft = CESIUM_LEDGER_SECTIONS.map((section) => `## ${section}\n- draft`).join("\n");
  const revised = CESIUM_LEDGER_SECTIONS.map((section) => `## ${section}\n- revised`).join("\n");
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 30_000,
    budgets,
    callModel: async (input) =>
      input.system.includes("auditing") ? revised : draft,
  });
  assert.equal(outcome.kind, "compacted");
  if (outcome.kind === "compacted") {
    assert.equal(outcome.ledger.body, revised);
    assert.ok(outcome.stats.verificationRevised);
  }
});

test("second-generation compaction merges previous ledger and carries quotes", async () => {
  const events = buildLongConversation(14);
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 24_000,
    intensity: 0.6,
    thresholdRatio: 0.6,
  });
  const genOneBody = CESIUM_LEDGER_SECTIONS.map(
    (section) => `## ${section}\n- gen1 fact`
  ).join("\n");
  const first = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 20_000,
    budgets,
    callModel: async (input) =>
      input.system.includes("auditing") ? "VERIFIED-OK" : genOneBody,
  });
  assert.equal(first.kind, "compacted");
  if (first.kind !== "compacted") return;

  // Persist gen-1 as a compression_summary event and grow the conversation.
  const summaryEvent: AgentStoredEvent = {
    seq: seqCounter + 1,
    eventId: "sum-1",
    conversationId: "conv-1",
    createdAt: Date.now(),
    kind: "compression_summary",
    messageId: "sum-1",
    summary: renderLedgerForContext(first.ledger),
    retainedTurnCount: 2,
    compressedTurnCount: 12,
    sourceRange: { fromSeq: first.stats.spanFromSeq, toSeq: first.stats.spanToSeq },
    generation: 1,
    raw: { engine: CESIUM_COMPACTION_ENGINE_ID, ledger: first.ledger },
  };
  seqCounter += 1;
  const moreEvents: AgentStoredEvent[] = [...events, summaryEvent];
  for (let turn = 0; turn < 10; turn += 1) {
    moreEvents.push(userEvent(`later turn ${turn} ${"more ".repeat(150)}`));
    moreEvents.push(...assistantEvents(`later answer ${turn} ${"words ".repeat(150)}`));
  }
  let sawPreviousLedgerInPrompt = false;
  const genTwoBody = CESIUM_LEDGER_SECTIONS.map(
    (section) => `## ${section}\n- gen2 merged fact`
  ).join("\n");
  const second = await runCesiumCompactionPipeline({
    events: moreEvents,
    usedTokens: budgets.triggerTokens + 20_000,
    budgets,
    callModel: async (input) => {
      if (input.user.includes("gen1 fact")) {
        sawPreviousLedgerInPrompt = true;
      }
      return input.system.includes("auditing") ? "VERIFIED-OK" : genTwoBody;
    },
  });
  assert.equal(second.kind, "compacted");
  if (second.kind === "compacted") {
    assert.equal(second.ledger.generation, 2);
    assert.ok(sawPreviousLedgerInPrompt, "previous ledger body must be fed to the merge prompt");
    // Quotes from generation 1 carry forward.
    assert.ok(second.ledger.userQuotes.some((quote) => quote.text.startsWith("turn 0")));
    // Span only covers events newer than the previous coverage boundary.
    assert.ok(second.stats.spanFromSeq > first.stats.spanToSeq);
  }
});

test("microcompact outcome preserves compression_summary events and covered history", async () => {
  resetSeq();
  const covered = userEvent("covered old turn");
  const ledger = {
    ...emptyCesiumLedger(),
    generation: 1,
    coveredToSeq: covered.seq,
    body: "## MISSION\n- continue",
  };
  const summary: AgentStoredEvent = {
    seq: covered.seq + 1,
    eventId: "sum",
    conversationId: "conv-1",
    createdAt: 1,
    kind: "compression_summary",
    messageId: "sum",
    summary: renderLedgerForContext(ledger),
    retainedTurnCount: 1,
    compressedTurnCount: 1,
    sourceRange: { fromSeq: 1, toSeq: covered.seq },
    generation: 1,
    raw: { engine: CESIUM_COMPACTION_ENGINE_ID, ledger },
  };
  seqCounter += 1;
  const events: AgentStoredEvent[] = [covered, summary];
  for (let turn = 0; turn < 6; turn += 1) {
    events.push(userEvent(`live turn ${turn}`));
    events.push(...toolEvents("terminal", `noise\n${"log ".repeat(3_000)}`));
    events.push(...assistantEvents(`ok ${turn}`));
  }
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 40_000,
    intensity: 1,
    thresholdRatio: 0.5,
  });
  const outcome = await runCesiumCompactionPipeline({
    events,
    usedTokens: budgets.triggerTokens + 500,
    budgets,
    callModel: null,
  });
  assert.equal(outcome.kind, "microcompact");
  if (outcome.kind === "microcompact") {
    assert.ok(
      outcome.events.some((event) => event.kind === "compression_summary"),
      "ledger summary event must survive microcompaction"
    );
    assert.ok(
      outcome.events.some((event) => event.seq === covered.seq),
      "covered events must remain in the stream (normalize skips them via the ledger)"
    );
    // The ledger must still render in assembled history.
    const messages = normalizeEventsToHistory(outcome.events);
    assert.ok(messages[1]!.content.startsWith("<context_ledger>"));
  }
});

test("latestLedgerFromEvents migrates legacy summaries", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 50,
      eventId: "legacy",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "compression_summary",
      messageId: "legacy",
      summary: "User: did things\nAssistant: ok",
      retainedTurnCount: 1,
      compressedTurnCount: 5,
      sourceRange: { fromSeq: 1, toSeq: 40 },
      generation: 3,
    },
  ];
  const ledger = latestLedgerFromEvents(events);
  assert.ok(ledger);
  assert.equal(ledger.generation, 3);
  assert.equal(ledger.coveredToSeq, 40);
  assert.equal(ledger.heuristic, true);
  assert.ok(ledger.body.includes("did things"));
});

// ---------------------------------------------------------------------------
// History layering
// ---------------------------------------------------------------------------

test("normalizeEventsToHistory renders the latest ledger after the system prompt and skips covered events", () => {
  resetSeq();
  const covered = userEvent("old covered message");
  const ledger = { ...emptyCesiumLedger(), generation: 1, coveredToSeq: covered.seq, body: "## MISSION\n- keep going" };
  const summary: AgentStoredEvent = {
    seq: covered.seq + 1,
    eventId: "sum",
    conversationId: "conv-1",
    createdAt: 2,
    kind: "compression_summary",
    messageId: "sum",
    summary: renderLedgerForContext(ledger),
    retainedTurnCount: 1,
    compressedTurnCount: 1,
    sourceRange: { fromSeq: 1, toSeq: covered.seq },
    generation: 1,
    raw: { engine: CESIUM_COMPACTION_ENGINE_ID, ledger },
  };
  seqCounter += 1;
  const live = userEvent("fresh message");
  const messages = normalizeEventsToHistory([covered, summary, live]);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[1]!.role, "user");
  assert.ok(messages[1]!.content.startsWith("<context_ledger>"));
  assert.ok(!messages.some((message) => message.content.includes("old covered message")));
  assert.ok(messages.some((message) => message.content.includes("fresh message")));
});

test("normalizeEventsToHistory drops superseded older summaries", () => {
  resetSeq();
  const oldSummary: AgentStoredEvent = {
    seq: 10,
    eventId: "sum-old",
    conversationId: "conv-1",
    createdAt: 1,
    kind: "compression_summary",
    messageId: "sum-old",
    summary: "OLD-SUMMARY-CONTENT",
    retainedTurnCount: 1,
    compressedTurnCount: 1,
    sourceRange: { fromSeq: 1, toSeq: 5 },
    generation: 1,
  };
  const newSummary: AgentStoredEvent = {
    seq: 20,
    eventId: "sum-new",
    conversationId: "conv-1",
    createdAt: 2,
    kind: "compression_summary",
    messageId: "sum-new",
    summary: "NEW-SUMMARY-CONTENT",
    retainedTurnCount: 1,
    compressedTurnCount: 2,
    sourceRange: { fromSeq: 1, toSeq: 15 },
    generation: 2,
  };
  seqCounter = 20;
  const live = userEvent("hello again");
  const messages = normalizeEventsToHistory([oldSummary, newSummary, live]);
  const joined = messages.map((message) => message.content).join("\n");
  assert.ok(joined.includes("NEW-SUMMARY-CONTENT"));
  assert.ok(!joined.includes("OLD-SUMMARY-CONTENT"));
});

// ---------------------------------------------------------------------------
// Warning buckets
// ---------------------------------------------------------------------------

test("compactionWarningBucket fires only inside the warning zone", () => {
  const budgets = resolveCompactionBudgets({
    contextWindowTokens: 100_000,
    intensity: 0.35,
    thresholdRatio: 0.82,
  });
  assert.equal(
    compactionWarningBucket({ usedTokens: 10_000, budgets }),
    null
  );
  const inZone = compactionWarningBucket({ usedTokens: budgets.warnTokens + 1_000, budgets });
  assert.ok(inZone != null && inZone >= 70);
  assert.equal(
    compactionWarningBucket({ usedTokens: budgets.triggerTokens + 1, budgets }),
    null
  );
});
