// One server process's share of a conversation: `create` makes it, `prompt` runs a turn.
// Both read OPENCURSOR_DATA_DIR and the model settings from the environment.
const [command, root, conversationId, text] = process.argv.slice(2);

const { ensureWorkspaceRegistered } = await import("../../src/lib/workspace-registry.js");
const { agentRuntimeManager } = await import("../../src/lib/agents/runtime-manager.js");
const { readConversationRecord, readConversationSnapshot } = await import("../../src/lib/agents/session-store.js");

const workspace = await ensureWorkspaceRegistered(root!, "cross-process");

if (command === "create") {
  const record = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: process.env.CESIUM_TEST_MODEL_ID!,
  });
  if (process.env.CESIUM_TEST_SETTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.CESIUM_TEST_SETTLE_MS)));
  }
  const stored = await readConversationRecord(workspace.id, record.id);
  console.log(JSON.stringify({ conversationId: record.id, providerSessionId: stored?.providerSessionId ?? null }));
} else if (command === "prompt") {
  const before = await readConversationRecord(workspace.id, conversationId!);
  const ends = (await readConversationSnapshot(workspace.id, conversationId!))?.events.filter(
    (event) => event.kind === "assistant_message_end"
  ).length ?? 0;
  await agentRuntimeManager.promptConversation(workspace, conversationId!, text!);
  const startedAt = Date.now();
  for (;;) {
    const snapshot = await readConversationSnapshot(workspace.id, conversationId!);
    const ended = snapshot?.events.filter((event) => event.kind === "assistant_message_end").length ?? 0;
    if (snapshot?.conversation.status === "idle" && ended > ends) break;
    if (snapshot?.conversation.status === "failed") throw new Error(`turn failed: ${snapshot.conversation.lastError}`);
    if (Date.now() - startedAt > 30_000) throw new Error("turn timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  console.log(JSON.stringify({ providerSessionIdBefore: before?.providerSessionId ?? null }));
}
process.exit(0);
