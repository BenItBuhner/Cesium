import assert from "node:assert/strict";
import { test } from "node:test";
import {
  antigravityEventToAgentEvents,
  antigravityPermissionRequestId,
  antigravityPlanArtifactFromTool,
  antigravityStartToolEvent,
  antigravityToolSnapshotFromEvent,
} from "../src/lib/agents/google-antigravity-cli-normalize.js";
import {
  buildAgyArgs,
  type GoogleAntigravityEvent,
} from "../src/lib/agents/google-antigravity-cli-session.js";
import {
  parseGoogleAntigravityTranscriptChunk,
} from "../src/lib/agents/google-antigravity-cli-transcript.js";

test("buildAgyArgs maps session options to agy flags", () => {
  assert.deepEqual(
    buildAgyArgs({
      addDirs: ["../shared"],
      conversationId: "conv-123",
      sandbox: true,
      dangerouslySkipPermissions: true,
      printTimeoutMs: 2500,
      logFile: ".agents/agy.log",
      prompt: "hello",
    }),
    [
      "--add-dir",
      "../shared",
      "--conversation=conv-123",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "3s",
      "--log-file",
      ".agents/agy.log",
      "--prompt-interactive",
      "hello",
    ]
  );
});

test("normalizer maps auth and resume events", () => {
  const authEvents = antigravityEventToAgentEvents({
    event: {
      type: "auth.required",
      sessionId: "s1",
      message: "Please sign in with Google OAuth",
      at: "2026-01-01T00:00:00.000Z",
    },
    conversationId: "c1",
    assistantMessageId: "m1",
  });
  assert.equal(authEvents[0]?.kind, "system");
  assert.equal(authEvents[1]?.kind, "status");
  assert.equal(authEvents[1]?.status, "failed");

  const resumeEvents = antigravityEventToAgentEvents({
    event: {
      type: "conversation.resumable",
      sessionId: "s1",
      conversationId: "01234567-89ab-cdef-0123-456789abcdef",
      command: "agy --conversation=01234567-89ab-cdef-0123-456789abcdef",
      at: "2026-01-01T00:00:00.000Z",
    },
    conversationId: "c1",
    assistantMessageId: "m1",
  });
  assert.equal(resumeEvents[0]?.kind, "system");
  assert.match(resumeEvents[0]?.text ?? "", /01234567-89ab/);
});

test("tool and permission events normalize to canonical OpenCursor events", () => {
  const toolEvent: Extract<GoogleAntigravityEvent, { type: "tool.proposed" }> = {
    type: "tool.proposed",
    sessionId: "s1",
    toolName: "grep_search",
    args: { query: "AgentBackendId" },
    stepIdx: 4,
    at: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(toolEvent.type, "tool.proposed");
  const snapshot = antigravityToolSnapshotFromEvent(toolEvent);
  const normalized = antigravityStartToolEvent({
    event: toolEvent,
    conversationId: "c1",
    snapshot,
  });
  assert.equal(normalized.kind, "tool_call");
  assert.equal(normalized.toolKind, "grep");
  assert.equal(normalized.status, "in_progress");

  const permissionEvent: Extract<GoogleAntigravityEvent, { type: "permission.requested" }> = {
    type: "permission.requested",
    sessionId: "s1",
    action: "run_command",
    target: "npm test",
    reason: "verify",
    at: "2026-01-01T00:00:00.000Z",
  };
  const permissionEvents = antigravityEventToAgentEvents({
    event: permissionEvent,
    conversationId: "c1",
    assistantMessageId: "m1",
  });
  const permissionRequest = permissionEvents.find((event) => event.kind === "permission_request");
  assert.equal(permissionRequest?.kind, "permission_request");
  assert.equal(permissionRequest?.requestId, antigravityPermissionRequestId(permissionEvent));
  assert.equal(permissionRequest?.options.length, 4);
});

test("manage_task payload is extracted for plan mirroring", () => {
  const artifact = antigravityPlanArtifactFromTool("manage_task", {
    title: "Ship harness",
    tasks: [
      { id: "one", content: "Wire backend", status: "completed" },
      { id: "two", content: "Run probes", status: "in_progress" },
    ],
  });
  assert.equal(artifact?.title, "Ship harness");
  assert.deepEqual(
    artifact?.entries?.map((entry) => [entry.id, entry.status]),
    [
      ["one", "completed"],
      ["two", "in_progress"],
    ]
  );
});

test("transcript tailer parser emits tool and artifact events", () => {
  const events = parseGoogleAntigravityTranscriptChunk(
    [
      JSON.stringify({
        source: "MODEL",
        type: "ANSWER",
        content: "Done",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        step_index: 2,
        type: "VIEW_FILE",
        tool_calls: [{ name: "view_file", args: { path: "README.md" } }],
      }),
      JSON.stringify({
        content: "created artifact C:/tmp/plan.plan.md",
      }),
    ].join("\n")
  );
  assert.equal(events.some((event) => event.type === "text.delta"), true);
  assert.equal(events.some((event) => event.type === "tool.proposed"), true);
  assert.equal(events.some((event) => event.type === "tool.finished"), true);
  assert.equal(events.some((event) => event.type === "artifact.created"), true);
});
