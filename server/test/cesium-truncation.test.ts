import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-truncation-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
await fs.mkdir(TEST_DATA_DIR, { recursive: true });

// Dynamic imports after the OPENCURSOR_DATA_DIR override so persistence.ts
// never freezes DATA_DIR to the real data directory.
const [
  { AGENT_BACKENDS },
  { createCesiumAgentProvider },
  { summarizeForCompression },
  { truncate, truncateMiddle },
  { BoundedTerminalOutput },
  { TERMINAL_OUTPUT_CAP },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/agents/cesium/cesium-history.js"),
  import("../src/lib/agents/cesium/cesium-coerce.js"),
  import("../src/lib/agents/cesium/cesium-terminal-output.js"),
  import("../src/lib/agents/cesium/cesium-prompt.js"),
]);

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const ELISION = /\.\.\.\[truncated \d+ chars from the middle\]\.\.\./;

test("truncateMiddle keeps both ends and marks the elided middle", () => {
  const value = `${"H".repeat(600)}${"m".repeat(2_000)}${"T".repeat(600)}`;
  const out = truncateMiddle(value, 1_000);
  assert.ok(out.startsWith("H".repeat(500)), "head is preserved");
  assert.ok(out.endsWith("T".repeat(500)), "tail is preserved");
  assert.match(out, ELISION);
  assert.ok(out.includes("truncated 2200 chars"), "marker reports the exact elided count");
  assert.equal(truncateMiddle("short", 1_000), "short");
  // The head-only helper still drops the tail: the two must not be conflated.
  assert.ok(!truncate(value, 1_000).includes("T"));
});

test("BoundedTerminalOutput freezes the head and rolls the tail", () => {
  const buffer = new BoundedTerminalOutput(100);
  buffer.append(`START-${"a".repeat(60)}`);
  for (let index = 0; index < 20; index += 1) {
    buffer.append("b".repeat(50));
  }
  buffer.append("\nFINAL LINE");
  const text = buffer.toString();
  assert.ok(text.startsWith("START-"), "opening survives");
  assert.ok(text.endsWith("FINAL LINE"), "newest bytes survive");
  assert.match(text, ELISION);
  assert.ok(buffer.omittedChars > 0);
  // Below the cap the buffer is a plain transcript with no marker.
  const small = new BoundedTerminalOutput(100);
  small.append("hello ");
  small.append("world");
  assert.equal(small.toString(), "hello world");
  assert.equal(small.omittedChars, 0);
});

function storedEvent(
  seq: number,
  event: Omit<AgentStoredEvent, "seq" | "eventId" | "conversationId" | "createdAt">
): AgentStoredEvent {
  return {
    seq,
    eventId: `evt-${seq}`,
    conversationId: "conv-compaction",
    createdAt: seq,
    ...event,
  } as AgentStoredEvent;
}

test("compaction digest keeps the newest compressed events, not just the oldest", () => {
  const events: AgentStoredEvent[] = [
    storedEvent(1, {
      kind: "user_message",
      messageId: "u-1",
      content: "ORIGINAL_TASK: build the widget end to end",
    }),
  ];
  // Enough tool activity to push the digest well past the 16k cap.
  for (let index = 0; index < 120; index += 1) {
    events.push(
      storedEvent(10 + index, {
        kind: "tool_call",
        toolCallId: `call-${index}`,
        title: `Read file-${index}.ts`,
        status: "in_progress",
        detail: "x".repeat(300),
      })
    );
  }
  events.push(
    storedEvent(999, {
      kind: "assistant_message_chunk",
      messageId: "a-last",
      text: "LATEST_DECISION: switched the widget to the streaming API",
    })
  );

  const digest = summarizeForCompression(events);
  assert.ok(digest.length <= 16_000 + 80, "digest honours the cap plus one marker");
  assert.ok(digest.includes("ORIGINAL_TASK"), "the opening task framing survives");
  assert.ok(
    digest.includes("LATEST_DECISION"),
    "the most recent compressed activity survives (head-only truncation dropped it)"
  );
  assert.match(digest, ELISION);
});

type TerminalToolHandle = {
  toolTerminal: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

async function startTerminalSession(): Promise<TerminalToolHandle> {
  const backend = AGENT_BACKENDS["cesium-agent"]!;
  const provider = await createCesiumAgentProvider({ backend });
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `cesium-terminal-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: "ws-terminal",
    title: "Terminal output test",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cesium-agent",
      mode: "agent",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const handle = await provider.startSession({
    conversation,
    workspace: { id: "ws-terminal", root: TEST_DATA_DIR, name: "terminal", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });
  return handle as unknown as TerminalToolHandle;
}

async function writeNodeScript(name: string, source: string): Promise<string> {
  const scriptPath = path.join(TEST_DATA_DIR, name);
  await fs.writeFile(scriptPath, source, "utf8");
  return `"${process.execPath}" "${scriptPath}"`;
}

test("terminal tool keeps the final output of a command that exceeds the cap", async () => {
  const handle = await startTerminalSession();
  try {
    const command = await writeNodeScript(
      "long-output.cjs",
      [
        `process.stdout.write("HEAD_MARKER_START\\n");`,
        `process.stdout.write("x".repeat(${TERMINAL_OUTPUT_CAP + 20_000}));`,
        `process.stdout.write("\\nTAIL_MARKER_LAST_LINE\\n");`,
      ].join("\n")
    );
    const result = await handle.toolTerminal({ command, timeoutMs: 20_000 });
    assert.ok(result.startsWith("Command exited 0."), result.slice(0, 120));
    assert.ok(result.includes("HEAD_MARKER_START"), "opening output is kept");
    assert.ok(
      result.includes("TAIL_MARKER_LAST_LINE"),
      "final output line survives instead of being dropped after the first 80KB"
    );
    assert.match(result, ELISION);
  } finally {
    await handle.dispose();
  }
});

test("terminal waitUntil=pattern matches text that arrives after the cap", async () => {
  const handle = await startTerminalSession();
  try {
    const command = await writeNodeScript(
      "late-pattern.cjs",
      [
        `process.stdout.write("y".repeat(${TERMINAL_OUTPUT_CAP + 10_000}));`,
        `process.stdout.write("\\nREADY_TOKEN_9f3a\\n");`,
        // Stay alive so only the pattern (not exit) can resolve the wait.
        `setTimeout(() => {}, 15_000);`,
      ].join("\n")
    );
    const result = await handle.toolTerminal({
      command,
      waitUntil: "pattern",
      pattern: "READY_TOKEN_9f3a",
      timeoutMs: 5_000,
    });
    assert.ok(
      result.startsWith("Pattern matched"),
      `expected the late pattern to match, got: ${result.slice(0, 120)}`
    );
  } finally {
    await handle.dispose();
  }
});
