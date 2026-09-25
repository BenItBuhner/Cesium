import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-subagent-transcript-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
  { findPersistedSubagentTranscript },
  { SubagentsV2Runtime },
  { defaultHarnessSettings },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/agents/cesium/subagent-toolset.js"),
  import("../src/lib/agents/cesium/features/subagents/v2-runtime.js"),
  import("../src/lib/agents/cesium/features/limits.js"),
]);

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function transcriptFor(label: string): AgentStoredEvent[] {
  return [
    {
      seq: 1,
      eventId: `${label}-u`,
      conversationId: "conv-parent",
      createdAt: 1,
      kind: "user_message",
      messageId: `${label}-msg`,
      content: `instructions for ${label}`,
    },
    {
      seq: 2,
      eventId: `${label}-a`,
      conversationId: "conv-parent",
      createdAt: 2,
      kind: "assistant_message_chunk",
      messageId: `${label}-reply`,
      text: `RESULT_${label}`,
    },
  ];
}

function subagentCard(input: {
  seq: number;
  subagentId: string;
  status: "running" | "completed" | "failed";
  transcript: AgentStoredEvent[];
}): AgentStoredEvent {
  return {
    seq: input.seq,
    eventId: `card-${input.seq}`,
    conversationId: "conv-parent",
    createdAt: input.seq,
    kind: "subagent",
    subagentId: input.subagentId,
    title: "Explore",
    status: input.status,
    transcript: input.transcript,
  };
}

test("findPersistedSubagentTranscript returns the newest card for the id by seq", () => {
  const partial = transcriptFor("partial").slice(0, 1);
  const full = transcriptFor("full");
  // Out of order on purpose: the newest card must win by seq, not position.
  const events: AgentStoredEvent[] = [
    subagentCard({ seq: 30, subagentId: "sub-1", status: "completed", transcript: full }),
    subagentCard({ seq: 10, subagentId: "sub-1", status: "running", transcript: partial }),
    subagentCard({ seq: 20, subagentId: "sub-2", status: "completed", transcript: transcriptFor("other") }),
  ];
  assert.deepEqual(findPersistedSubagentTranscript(events, "sub-1"), full);
  assert.equal(findPersistedSubagentTranscript(events, "missing"), null);
  assert.equal(findPersistedSubagentTranscript([], "sub-1"), null);
});

type SubagentToolHandle = {
  toolReadSubagentTranscript: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

test("read_subagent_transcript falls back to the persisted card after the runtime is gone", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"]!;
  const provider = await createCesiumAgentProvider({ backend });
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "cesium-subagent-restart",
    workspaceId: "ws-subagent",
    title: "Subagent transcript after restart",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 3,
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
  // A previous session ran the subagent and persisted its card; this fresh
  // handle (post-restart) has an empty in-memory transcript map.
  const persisted: AgentStoredEvent[] = [
    subagentCard({
      seq: 3,
      subagentId: "call-explore-1",
      status: "completed",
      transcript: transcriptFor("explore"),
    }),
  ];
  const handle = (await provider.startSession({
    conversation,
    workspace: { id: "ws-subagent", root: TEST_DATA_DIR, name: "subagent", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => ({ conversation, events: persisted }),
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  })) as unknown as SubagentToolHandle;
  try {
    const result = await handle.toolReadSubagentTranscript({ subagentId: "call-explore-1" });
    assert.ok(
      !result.startsWith("No ephemeral subagent transcript found"),
      `expected the persisted transcript, got: ${result.slice(0, 120)}`
    );
    assert.ok(result.includes("RESULT_explore"), "transcript body is returned");
    assert.ok(result.startsWith("user_message: "), "same kind-prefixed line format as the live path");
    const unknown = await handle.toolReadSubagentTranscript({ subagentId: "never-ran" });
    assert.ok(unknown.startsWith("No ephemeral subagent transcript found for never-ran"));
  } finally {
    await handle.dispose();
  }
});

test("Subagents V2 read_subagent_transcript uses the persisted transcript for unknown agents", async () => {
  const persisted = transcriptFor("v2child");
  const runtime = new SubagentsV2Runtime({
    conversationId: "conv-v2-restart",
    limits: defaultHarnessSettings().limits,
    defaultModelId: "unittestprov/missing-model-for-unit-test",
    appendEvents: async () => {},
    readPersistedTranscript: async (subagentId) =>
      subagentId === "/root/explore_auth" ? persisted : null,
  });
  const result = await runtime.readTranscript({ subagentId: "/root/explore_auth" });
  assert.ok(
    result.includes("RESULT_v2child"),
    `expected the persisted transcript, got: ${result.slice(0, 120)}`
  );
  assert.ok(
    (await runtime.readTranscript({ subagentId: "/root/never" })).startsWith(
      "No collaborative subagent transcript found for /root/never"
    )
  );
});
