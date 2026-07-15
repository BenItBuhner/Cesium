/**
 * Manual-test helper: writes a conversation with a handful of user_message
 * events into the legacy JSON store so the composer arrow-key history
 * feature can be exercised without a live agent backend.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

async function main() {
const workspaceId = process.argv[2] ?? "8af22c44f404";
const dataDir = path.resolve(os.homedir(), ".local/state/cesium");
const conversationId = `seed-${randomUUID().slice(0, 8)}`;
const conversationDir = path.join(
  dataDir,
  "workspaces",
  workspaceId,
  "conversations",
  conversationId
);
await fs.mkdir(conversationDir, { recursive: true });

const now = Date.now();
const userMessages = [
  "first test message — this is the oldest one",
  "second test message about refactoring",
  "third test message: explain the build error",
  "fourth and newest test message",
];

const events = userMessages.flatMap((content, i) => {
  const seq = i * 2 + 1;
  return [
    {
      seq,
      eventId: randomUUID(),
      conversationId,
      kind: "user_message" as const,
      messageId: randomUUID(),
      content,
      createdAt: now - (userMessages.length - i) * 60_000,
    },
    {
      seq: seq + 1,
      eventId: randomUUID(),
      conversationId,
      kind: "assistant_message_chunk" as const,
      messageId: `asst-${i}`,
      text: `(mock assistant reply to: ${content.slice(0, 30)})`,
      createdAt: now - (userMessages.length - i) * 60_000 + 100,
    },
  ];
});

await fs.writeFile(
  path.join(conversationDir, "events.jsonl"),
  `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  "utf8"
);

const lastSeq = events[events.length - 1]!.seq;

const meta = {
  schemaVersion: 1,
  id: conversationId,
  workspaceId,
  title: "Arrow-key history test",
  status: "idle",
  createdAt: now,
  updatedAt: now,
  lastEventSeq: lastSeq,
  providerSessionId: null,
  config: {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "auto",
    modelName: "Auto",
  },
  configOptions: [],
  pendingPermission: null,
  capabilities: {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: false,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  experimental: false,
  archivedAt: null,
  lastReadSeq: lastSeq,
  queuedPrompts: [],
  lastError: null,
};

await fs.writeFile(
  path.join(conversationDir, "meta.json"),
  JSON.stringify(meta, null, 2),
  "utf8"
);

console.log(
  `Seeded conversation ${conversationId} with ${userMessages.length} user messages.`
);
console.log(
  `Open: http://localhost:3000/agent?conversationId=${conversationId}`
);
}

main().catch((err) => { console.error(err); process.exit(1); });
