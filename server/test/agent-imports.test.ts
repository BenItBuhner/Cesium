import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

/**
 * Cross-harness conversation import: readers for every supported harness's
 * local storage, plus the importer's identity/idempotency guarantees.
 *
 * Fixtures under ./fixtures/harness-home are REAL session artifacts captured
 * from the actual CLIs (Claude Code 2.1, Codex 0.146, OpenCode 1.18, Pi 0.73)
 * plus a Gemini CLI-format chat (jsonl + legacy json document).
 */

const fixtureHome = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "harness-home"
);
const fixtureCopy = path.join(
  os.tmpdir(),
  `cesium-import-fixtures-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-import-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

await fs.cp(fixtureHome, fixtureCopy, { recursive: true, preserveTimestamps: true });

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.CLAUDE_CONFIG_DIR = path.join(fixtureCopy, ".claude");
process.env.CODEX_HOME = path.join(fixtureCopy, ".codex");
process.env.XDG_DATA_HOME = path.join(fixtureCopy, ".local", "share");
process.env.GEMINI_CLI_HOME = path.join(fixtureCopy, ".gemini");
process.env.PI_CODING_AGENT_DIR = path.join(fixtureCopy, ".pi", "agent");

const CLAUDE_SESSION_ID = "6d7b9127-a7b1-4e1c-8957-6c010b928558";
const CLAUDE_TOOL_SESSION_ID = "3a45417e-04e2-4a0d-a298-42e01b534d3c";
const CODEX_THREAD_ID = "019fad5f-fd1f-7820-9cc0-dbfdf80312e6";
const CODEX_TOOL_THREAD_ID = "019fad60-5630-7083-b4e2-2f4089b34bfd";
const OPENCODE_SESSION_ID = "ses_0529ecb02ffen6It3TTtu2saFy";
const OPENCODE_TOOL_SESSION_ID = "ses_0529dc0c0ffeUwW1rOlb8Md7k2";
const PI_SESSION_ID = "019fad63-12d1-7343-a44a-fe7127b14e66";
const GEMINI_SESSION_ID = "c634bc02-d7e6-4d35-b912-714a62b0936f";
const GEMINI_LEGACY_SESSION_ID = "legacy-1111-2222-3333-444455556666";

const [
  { createClaudeCodeImportSource, claudeProjectSlugForCwd },
  { createCodexImportSource },
  { createOpenCodeImportSource },
  { createPiImportSource },
  { createGeminiImportSource },
  { importHarnessSession, findImportedConversation, maybeAutoSyncImportedConversation },
  { getImportSourceForBackend },
  { ensureWorkspaceRegistered },
  sessionStore,
  { AgentRuntimeManager },
  { AGENT_BACKENDS },
] = await Promise.all([
  import("../src/lib/agents/import/sources/claude-code.js"),
  import("../src/lib/agents/import/sources/codex.js"),
  import("../src/lib/agents/import/sources/opencode.js"),
  import("../src/lib/agents/import/sources/pi.js"),
  import("../src/lib/agents/import/sources/gemini.js"),
  import("../src/lib/agents/import/importer.js"),
  import("../src/lib/agents/import/registry.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/providers.js"),
]);

// A manager whose backends are all "available" and whose providers never
// spawn: handoff logic is exercised without CLI processes or credentials.
const runtimeManager = new AgentRuntimeManager({
  backends: Object.fromEntries(
    Object.entries(AGENT_BACKENDS).map(([id, backend]) => [id, { ...backend, available: true }])
  ) as typeof AGENT_BACKENDS,
  createProvider: async () => {
    throw new Error("provider runtimes are not spawned in import tests");
  },
});

function textOf(events: AgentStoredEvent[]): string {
  return events
    .map((event) =>
      event.kind === "user_message"
        ? event.content
        : event.kind === "assistant_message_chunk" || event.kind === "reasoning"
          ? event.text
          : ""
    )
    .join("\n");
}

test("claude reader lists and reads real Claude Code sessions", async () => {
  const source = createClaudeCodeImportSource();
  const detection = await source.detect();
  assert.equal(detection.available, true);

  const sessions = await source.listSessions();
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(CLAUDE_SESSION_ID));
  assert.ok(ids.includes(CLAUDE_TOOL_SESSION_ID));

  // ai-title entry wins as the list title for the tool session.
  const toolSummary = sessions.find((session) => session.id === CLAUDE_TOOL_SESSION_ID)!;
  assert.equal(toolSummary.title, "Create haiku file about the sea");
  assert.equal(toolSummary.cwd, "/tmp/harness-playground/claude");

  const transcript = await source.readSession(CLAUDE_TOOL_SESSION_ID);
  const kinds = transcript.events.map((event) => event.kind);
  // Exactly one user text message; tool_result user entries fold into tool cards.
  assert.equal(kinds.filter((kind) => kind === "user_message").length, 1);
  assert.ok(kinds.includes("tool_call"));
  const toolCalls = transcript.events.filter((event) => event.kind === "tool_call");
  // Tool cards run through the shared normalizer — same titles as live turns.
  assert.equal(toolCalls[0]!.kind === "tool_call" && toolCalls[0]!.title, "Update haiku.txt");
  assert.equal(toolCalls[0]!.kind === "tool_call" && toolCalls[0]!.toolKind, "edit");
  const updates = transcript.events.filter((event) => event.kind === "tool_call_update");
  // The update's detail is the readable result (the written file content),
  // and the card carries the file location — no raw JSON dumps.
  assert.ok(
    updates.some(
      (event) =>
        event.kind === "tool_call_update" &&
        event.detail?.includes("Waves crash on the shore") &&
        event.locations?.some((location) => location.path.endsWith("haiku.txt"))
    )
  );
  const text = textOf(transcript.events as AgentStoredEvent[]);
  assert.ok(text.includes("Create a file named haiku.txt containing a haiku about the sea"));
});

test("claude reader prefers the newest copy of a re-homed session", async () => {
  const source = createClaudeCodeImportSource();
  // The fixture holds two copies of CLAUDE_SESSION_ID: the original playground
  // file (2 user turns) and a -workspace copy the harness kept appending to
  // (3 user turns). The newest copy must win.
  const transcript = await source.readSession(CLAUDE_SESSION_ID);
  const userTurns = transcript.events.filter((event) => event.kind === "user_message");
  assert.equal(userTurns.length, 3);
  assert.ok(transcript.summary.sourcePath.includes("-workspace"));
  assert.equal(claudeProjectSlugForCwd("/workspace"), "-workspace");
});

test("codex reader lists and reads real Codex rollouts", async () => {
  const source = createCodexImportSource();
  const sessions = await source.listSessions();
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(CODEX_THREAD_ID));
  assert.ok(ids.includes(CODEX_TOOL_THREAD_ID));

  const transcript = await source.readSession(CODEX_THREAD_ID);
  const userMessages = transcript.events.filter((event) => event.kind === "user_message");
  // The fixture thread holds the two original exec turns plus native
  // continuation turns that were appended through Cesium after import.
  assert.ok(userMessages.length >= 2);
  assert.ok(
    userMessages[0]!.kind === "user_message" &&
      userMessages[0]!.content.includes("17 times 23")
  );
  assert.ok(
    userMessages[1]!.kind === "user_message" &&
      userMessages[1]!.content.includes("multiply that result by 2")
  );
  // Harness-injected scaffolding (environment_context etc.) must not import.
  const text = textOf(transcript.events as AgentStoredEvent[]);
  assert.ok(!text.includes("environment_context"));
  assert.ok(text.includes("782"));

  const toolTranscript = await source.readSession(CODEX_TOOL_THREAD_ID);
  const toolCalls = toolTranscript.events.filter((event) => event.kind === "tool_call");
  assert.ok(toolCalls.length >= 1);
  // Shell calls render as native terminal cards ("Ran <command>"), never raw JSON.
  assert.ok(
    toolCalls.some((event) => event.kind === "tool_call" && event.title.startsWith("Ran "))
  );
  assert.ok(
    toolTranscript.events.some((event) => event.kind === "tool_call_update" && event.detail)
  );
});

test("opencode reader reads the SQLite store", async () => {
  const source = createOpenCodeImportSource();
  const detection = await source.detect();
  assert.equal(detection.available, true);

  const sessions = await source.listSessions();
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(OPENCODE_SESSION_ID));
  assert.ok(ids.includes(OPENCODE_TOOL_SESSION_ID));
  const toolSummary = sessions.find((session) => session.id === OPENCODE_TOOL_SESSION_ID)!;
  assert.equal(toolSummary.title, "Storm.txt thunderstorm poem creation");

  const transcript = await source.readSession(OPENCODE_TOOL_SESSION_ID);
  const text = textOf(transcript.events as AgentStoredEvent[]);
  assert.ok(text.includes("Thunder rolls across the sky"));
  const toolCalls = transcript.events.filter((event) => event.kind === "tool_call");
  assert.ok(toolCalls.length >= 2);
  assert.ok(
    toolCalls.some(
      (event) => event.kind === "tool_call" && event.detail?.includes("Thunder rolls across the sky")
    ),
    "write tool call carries the poem input verbatim"
  );
  assert.ok(
    toolCalls.some(
      (event) => event.kind === "tool_call" && event.detail?.includes("storm.txt")
    )
  );
  // Exactly one assistant_message_end per assistant message (not one per part).
  const endIds = transcript.events
    .filter((event) => event.kind === "assistant_message_end")
    .map((event) => (event.kind === "assistant_message_end" ? event.messageId : ""));
  assert.equal(new Set(endIds).size, endIds.length);
});

test("pi reader lists and reads real Pi sessions", async () => {
  const source = createPiImportSource();
  const sessions = await source.listSessions();
  assert.ok(sessions.map((session) => session.id).includes(PI_SESSION_ID));

  const transcript = await source.readSession(PI_SESSION_ID);
  const text = textOf(transcript.events as AgentStoredEvent[]);
  assert.ok(text.includes("What is the largest planet? One word."));
  assert.ok(text.includes("Jupiter"));
  const reasoning = transcript.events.find((event) => event.kind === "reasoning");
  assert.ok(reasoning);
  const toolCall = transcript.events.find((event) => event.kind === "tool_call");
  // Pi's `write` tool normalizes into the shared edit-card title format.
  assert.ok(toolCall && toolCall.kind === "tool_call" && /^Update /.test(toolCall.title));
  const update = transcript.events.find((event) => event.kind === "tool_call_update");
  assert.ok(
    update && update.kind === "tool_call_update" && update.detail?.includes("Successfully wrote")
  );
});

test("gemini reader handles jsonl checkpoints and legacy json documents", async () => {
  const source = createGeminiImportSource();
  const sessions = await source.listSessions();
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes(GEMINI_SESSION_ID));
  assert.ok(ids.includes(GEMINI_LEGACY_SESSION_ID));

  const transcript = await source.readSession(GEMINI_SESSION_ID);
  const text = textOf(transcript.events as AgentStoredEvent[]);
  assert.ok(text.includes("Write a couplet about mountains into peaks.txt"));
  assert.ok(text.includes("Granite shoulders touch the sky"));
  const reasoning = transcript.events.find((event) => event.kind === "reasoning");
  assert.ok(reasoning && reasoning.kind === "reasoning" && reasoning.text.includes("Planning"));
  const toolCalls = transcript.events.filter((event) => event.kind === "tool_call");
  assert.equal(toolCalls.length, 2);
  assert.ok(
    toolCalls.every((event) => event.kind === "tool_call" && event.status === "completed")
  );

  const legacy = await source.readSession(GEMINI_LEGACY_SESSION_ID);
  const legacyText = textOf(legacy.events as AgentStoredEvent[]);
  assert.ok(legacyText.includes("What is 2+2? One word."));
  assert.ok(legacyText.includes("Four"));
});

test("importer preserves native identity, verbatim content, and upserts on re-import", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");

  const first = await importHarnessSession({
    workspace,
    backendId: "claude-code-sdk",
    externalSessionId: CLAUDE_SESSION_ID,
  });
  assert.equal(first.created, true);
  assert.equal(first.providerSessionId, CLAUDE_SESSION_ID);

  const record = await sessionStore.readConversationRecord(workspace.id, first.conversationId);
  assert.ok(record);
  assert.equal(record!.config.backendId, "claude-code-sdk");
  assert.equal(record!.providerSessionId, CLAUDE_SESSION_ID);
  assert.equal(record!.origin?.kind, "import");
  assert.ok(record!.origin?.kind === "import");
  assert.equal(record!.origin.externalSessionId, CLAUDE_SESSION_ID);

  const events = await sessionStore.readConversationEvents(workspace.id, first.conversationId);
  const text = textOf(events);
  assert.ok(text.includes("What is the capital of France? Answer in exactly one word."));
  assert.ok(text.includes("Paris"));
  assert.ok(text.includes("France"));

  // Re-import: same conversation, modified in place, no duplicated events.
  const second = await importHarnessSession({
    workspace,
    backendId: "claude-code-sdk",
    externalSessionId: CLAUDE_SESSION_ID,
  });
  assert.equal(second.created, false);
  assert.equal(second.conversationId, first.conversationId);
  const eventsAfter = await sessionStore.readConversationEvents(workspace.id, first.conversationId);
  assert.equal(eventsAfter.length, events.length);

  const found = await findImportedConversation(workspace.id, "claude-code-sdk", CLAUDE_SESSION_ID);
  assert.equal(found?.id, first.conversationId);

  // The native artifact was re-homed for the workspace cwd.
  const rehomed = path.join(
    fixtureCopy,
    ".claude",
    "projects",
    "-workspace",
    `${CLAUDE_SESSION_ID}.jsonl`
  );
  assert.ok(await fs.stat(rehomed).then(() => true).catch(() => false));

  // A session that only exists in its original project dir gets copied into
  // the workspace-keyed dir on import (the CLI then lists it natively there).
  const toolImport = await importHarnessSession({
    workspace,
    backendId: "claude-code-sdk",
    externalSessionId: CLAUDE_TOOL_SESSION_ID,
  });
  assert.equal(toolImport.created, true);
  const rehomedTool = path.join(
    fixtureCopy,
    ".claude",
    "projects",
    "-workspace",
    `${CLAUDE_TOOL_SESSION_ID}.jsonl`
  );
  assert.ok(await fs.stat(rehomedTool).then(() => true).catch(() => false));
});

test("imported turns settle with terminal status events (no phantom Working)", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");
  const imported = await importHarnessSession({
    workspace,
    backendId: "claude-code-sdk",
    externalSessionId: CLAUDE_SESSION_ID,
  });
  const events = await sessionStore.readConversationEvents(workspace.id, imported.conversationId);
  const userTurns = events.filter((event) => event.kind === "user_message");
  const idleStatuses = events.filter(
    (event) => event.kind === "status" && event.status === "idle"
  );
  // One terminal idle per turn: the projection settles every turn instead of
  // rendering a perpetual "Working" indicator on the imported thread.
  assert.equal(idleStatuses.length, userTurns.length);
  const last = events[events.length - 1]!;
  assert.ok(last.kind === "status" && last.status === "idle");
});

test("auto-sync pulls CLI-side continuations without any manual re-sync", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");
  const imported = await importHarnessSession({
    workspace,
    backendId: "claude-code-sdk",
    externalSessionId: CLAUDE_SESSION_ID,
  });

  // Nothing changed on the harness side — opening the conversation is a no-op.
  const before = await sessionStore.readConversationRecord(workspace.id, imported.conversationId);
  assert.equal(
    await maybeAutoSyncImportedConversation(workspace, before!, { ignoreThrottle: true }),
    false
  );

  // Simulate the user continuing the same session directly in the Claude CLI:
  // the harness appends new entries to its own session file.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sessionFile = path.join(
    fixtureCopy,
    ".claude",
    "projects",
    "-workspace",
    `${CLAUDE_SESSION_ID}.jsonl`
  );
  const laterTs = new Date(Date.now() + 50).toISOString();
  const cliTurn =
    JSON.stringify({
      type: "user",
      uuid: randomUUID(),
      timestamp: laterTs,
      sessionId: CLAUDE_SESSION_ID,
      cwd: "/workspace",
      message: { role: "user", content: "And what about Nauru? One word." },
    }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      timestamp: laterTs,
      sessionId: CLAUDE_SESSION_ID,
      cwd: "/workspace",
      message: {
        id: `msg-${randomUUID()}`,
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "Yaren" }],
      },
    }) +
    "\n";
  await fs.appendFile(sessionFile, cliTurn, "utf8");

  // Opening the conversation now transparently pulls the CLI-side turn in.
  const record = await sessionStore.readConversationRecord(workspace.id, imported.conversationId);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const synced = await maybeAutoSyncImportedConversation(workspace, record!, {
    ignoreThrottle: true,
  });
  assert.equal(synced, true);
  const events = await sessionStore.readConversationEvents(workspace.id, imported.conversationId);
  const text = textOf(events);
  assert.ok(text.includes("And what about Nauru? One word."));
  assert.ok(text.includes("Yaren"));
});

test("importer works for every harness backend with local storage", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");
  const cases: Array<[Parameters<typeof importHarnessSession>[0]["backendId"], string, string]> = [
    ["codex-app-server", CODEX_THREAD_ID, "17 times 23"],
    ["opencode-server", OPENCODE_SESSION_ID, "Orange"],
    ["opencode-v2-beta", OPENCODE_SESSION_ID, "Orange"],
    ["pi-agent", PI_SESSION_ID, "Jupiter"],
    ["google-antigravity-cli", GEMINI_SESSION_ID, "Granite shoulders"],
  ];
  for (const [backendId, sessionId, needle] of cases) {
    const source = getImportSourceForBackend(backendId);
    assert.ok(source, `import source registered for ${backendId}`);
    const result = await importHarnessSession({ workspace, backendId, externalSessionId: sessionId });
    assert.equal(result.created, true, backendId);
    assert.ok(result.providerSessionId, backendId);
    const events = await sessionStore.readConversationEvents(workspace.id, result.conversationId);
    assert.ok(textOf(events).includes(needle), `${backendId} verbatim content`);
    const record = await sessionStore.readConversationRecord(workspace.id, result.conversationId);
    assert.equal(record!.config.backendId, backendId);
  }
});

test("handoff back to the origin harness resumes the native session", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");
  const imported = await importHarnessSession({
    workspace,
    backendId: "codex-app-server",
    externalSessionId: CODEX_THREAD_ID,
  });

  // Outbound handoff: transcript transfer, provider session cleared.
  await runtimeManager.handoffConversation(
    workspace,
    imported.conversationId,
    "claude-code-sdk"
  );
  const afterOutbound = await sessionStore.readConversationRecord(
    workspace.id,
    imported.conversationId
  );
  assert.equal(afterOutbound!.config.backendId, "claude-code-sdk");
  assert.equal(afterOutbound!.providerSessionId, null);

  // Round trip: handing back to the origin harness natively resumes the
  // original Codex thread instead of replaying a transcript.
  await runtimeManager.handoffConversation(
    workspace,
    imported.conversationId,
    "codex-app-server"
  );
  const afterReturn = await sessionStore.readConversationRecord(
    workspace.id,
    imported.conversationId
  );
  assert.equal(afterReturn!.config.backendId, "codex-app-server");
  assert.equal(afterReturn!.providerSessionId, CODEX_THREAD_ID);

  const events = await sessionStore.readConversationEvents(workspace.id, imported.conversationId);
  const handoffs = events.filter((event) => event.kind === "agent_handoff");
  assert.equal(handoffs.length, 2);
  const roundTrip = handoffs[1]!;
  assert.ok(roundTrip.kind === "agent_handoff" && roundTrip.resumeNativeSession === true);
  // No transcript assistant message was injected for the native resume leg.
  const roundTripSeq = roundTrip.seq;
  const transcriptBefore = events.find(
    (event) =>
      event.kind === "assistant_message_chunk" &&
      event.seq === roundTripSeq - 1 &&
      event.text.includes("transferred")
  );
  assert.equal(transcriptBefore, undefined);
});

test("import rejects harnesses without local storage", async () => {
  const workspace = await ensureWorkspaceRegistered("/workspace", "Import Test Workspace");
  await assert.rejects(
    importHarnessSession({
      workspace,
      backendId: "cursor-sdk",
      externalSessionId: randomUUID(),
    })
  );
});
