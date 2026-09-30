import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-context-pruning-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "pruning");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
const bigFile = (label: string) =>
  Array.from({ length: 600 }, (_, index) => `${label} line ${String(index).padStart(4, "0")} ${"x".repeat(30)}`).join("\n");
for (const label of ["one", "two", "three"]) {
  await fs.writeFile(path.join(WORKSPACE_ROOT, `${label}.txt`), bigFile(label));
}

for (const key of [
  "REDIS_URL",
  "DATABASE_URL",
  "OPENCURSOR_STORAGE_DRIVER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TITLE_MODEL",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[] };
type Responder = (res: ServerResponse) => void;

const scripted: Responder[] = [];
const agentRequests: ChatRequest[] = [];
const summaryRequests: ChatRequest[] = [];
let summaryMode: "ok" | "fail" = "ok";
const pruneSummaryRequests: ChatRequest[] = [];
let pruneSummaryReply: string = "Pruning Test";
const MODEL_SUMMARY = [
  "## Objective",
  "Read one.txt and keep a todo list about it.",
  "## Decisions and why",
  "Read the file in one call because it is small enough.",
  "## Files touched",
  "one.txt (read)",
  "## Tried and failed",
  "None.",
  "## Open questions",
  "None.",
  "## Next steps",
  "Answer the user's follow-up questions.",
].join("\n");
const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      const system = typeof body.messages[0]?.content === "string" ? body.messages[0].content : "";
      if (system.startsWith("You condense")) {
        pruneSummaryRequests.push(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: pruneSummaryReply } }] }));
        return;
      }
      if (system.startsWith("You summarize")) {
        summaryRequests.push(body);
        if (summaryMode === "fail") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "summary backend down" } }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: MODEL_SUMMARY } }] }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Pruning Test" } }] }));
      return;
    }
    agentRequests.push(body);
    const responder = scripted.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
      return;
    }
    responder(res);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const MODEL_PORT = (modelServer.address() as AddressInfo).port;

process.env.CESIUM_BASE_URL = `http://127.0.0.1:${MODEL_PORT}/v1`;
process.env.CESIUM_API_KEY = "sk-test-pruning";
process.env.CESIUM_PROVIDER_ID = "prunehost";
process.env.CESIUM_MODELS = JSON.stringify([{ id: "tiny", contextWindow: 20_000 }]);
process.env.CESIUM_DEFAULT_MODEL = "tiny";
const MODEL_ID = "prunehost/tiny";

const [{ ensureWorkspaceRegistered }, { agentRuntimeManager }, { readConversationSnapshot }] =
  await Promise.all([
    import("../src/lib/workspace-registry.js"),
    import("../src/lib/agents/runtime-manager.js"),
    import("../src/lib/agents/session-store.js"),
  ]);

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function readTurn(id: string, file: string, promptTokens: number): Responder {
  return toolTurn(id, "read_file", { path: file }, promptTokens);
}

function toolTurn(id: string, name: string, args: Record<string, unknown>, promptTokens: number): Responder {
  return (res) =>
    sse(res, [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20 } },
    ]);
}

function textTurn(text: string, promptTokens: number): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 10 } },
    ]);
}

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

async function waitForIdle(workspaceId: string, conversationId: string, turns: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const snapshot = await readConversationSnapshot(workspaceId, conversationId);
    const ended =
      snapshot?.events.filter((event: AgentStoredEvent) => event.kind === "assistant_message_end").length ?? 0;
    if (snapshot && snapshot.conversation.status === "idle" && ended >= turns) {
      return snapshot;
    }
    if (snapshot?.conversation.status === "failed") {
      throw new Error(`turn failed: ${snapshot.conversation.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the turn to finish.");
}

const ONE_SUMMARY = "one.txt has 600 lines, 'one line 0000' through 'one line 0599', each padded with x.";

for (const summaries of [false, true]) {
test(`tool results shrink with the headroom and old ones are pruned once, at a boundary later requests extend (${summaries ? "with" : "without"} summaries)`, async () => {
  const firstRequest = agentRequests.length;
  const firstPruneSummary = pruneSummaryRequests.length;
  pruneSummaryReply = summaries
    ? `Here you go:\n\`\`\`json\n${JSON.stringify({ call_one_s: ONE_SUMMARY, call_two_s: "not pruned" })}\n\`\`\``
    : "Pruning Test";
  const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "pruning");
  const conversation = await agentRuntimeManager.createConversation(workspace, {
    backendId: "cesium-agent",
    modelId: MODEL_ID,
    modelName: "Tiny",
  });
  const id = (name: string) => (summaries ? `${name}_s` : name);
  scripted.push(
    readTurn(id("call_one"), "one.txt", 4_000),
    readTurn(id("call_two"), "two.txt", 9_000),
    readTurn(id("call_three"), "three.txt", 17_500),
    textTurn("Read all three.", 12_000)
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read one, two and three.");
  await waitForIdle(workspace.id, conversation.id, 1);
  scripted.push(textTurn("Yes, all three.", 12_500));
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Did you read them?");
  const snapshot = await waitForIdle(workspace.id, conversation.id, 2);

  const requests = agentRequests.slice(firstRequest);
  assert.equal(requests.length, 5);
  const [r1, r2, r3, r4, r5] = requests.map((request) => request.messages);
  const extends_ = (current: ChatMessage[], previous: ChatMessage[]) =>
    assert.deepEqual(current.slice(0, previous.length), previous);
  extends_(r2!, r1!);
  extends_(r3!, r2!);

  const toolResult = (messages: ChatMessage[], id: string) =>
    messages.find((message) => message.role === "tool" && message.tool_call_id === id);
  const updates = snapshot.events.filter(
    (event): event is Extract<AgentStoredEvent, { kind: "tool_call_update" }> =>
      event.kind === "tool_call_update" && event.status === "completed"
  );
  const budgetOf = (callId: string) =>
    (updates.find((event) => event.toolCallId === callId)?.raw as { modelBudget?: number } | undefined)?.modelBudget;
  assert.equal(budgetOf(id("call_one")), 12_000, "a result over the cap keeps the per-result budget");
  assert.ok((budgetOf(id("call_two")) ?? 0) < 12_000, "less headroom, smaller budget");
  assert.equal(budgetOf(id("call_three")), 2_000, "a nearly full window still leaves the floor");
  const spillPath = (updates.find((event) => event.toolCallId === id("call_one"))?.raw as { spillPath?: string }).spillPath!;
  assert.match(messageText(toolResult(r2!, id("call_one"))), new RegExp(`saved at ${spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(
    await fs.readFile(spillPath, "utf8"),
    updates.find((event) => event.toolCallId === id("call_one"))?.detail,
    "the full output is kept for read_file"
  );

  const boundary = snapshot.events.find(
    (event): event is Extract<AgentStoredEvent, { kind: "compression_summary" }> =>
      event.kind === "compression_summary" && Boolean(event.prunedToolCallIds)
  );
  assert.deepEqual(boundary?.prunedToolCallIds, [id("call_one")], "only results outside the newest two batches");
  if (summaries) {
    assert.equal(pruneSummaryRequests.length - firstPruneSummary, 1, "one summary call per boundary");
    const asked = messageText(pruneSummaryRequests.at(-1)!.messages[1]);
    assert.match(asked, new RegExp(`### ${id("call_one")}\\nTool: read_file`));
    assert.doesNotMatch(asked, /### call_two_s/, "only the pruned results are summarized");
    assert.deepEqual(boundary?.prunedSummaries, { [id("call_one")]: ONE_SUMMARY }, "ids not pruned are dropped");
  } else {
    assert.equal(boundary?.prunedSummaries, undefined, "an unusable reply leaves plain stubs");
  }

  const prunedIndex = r3!.findIndex((message) => message.role === "tool" && message.tool_call_id === id("call_one"));
  assert.deepEqual(r4!.slice(0, prunedIndex), r3!.slice(0, prunedIndex), "the boundary keeps everything before the pruned result");
  assert.match(
    messageText(r4![prunedIndex]),
    summaries
      ? new RegExp(`^\\[read_file output \\(\\d+ chars\\) pruned to free context\\. What it showed: ${ONE_SUMMARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} It is saved at `)
      : /^\[read_file output \(\d+ chars\) pruned to free context\. It is saved at /
  );
  assert.deepEqual(r4!.slice(prunedIndex + 1, r3!.length), r3!.slice(prunedIndex + 1), "and everything after it");
  assert.ok(r4!.length > r3!.length);

  extends_(r5!, r4!);
  assert.equal(messageText(r5!.at(-1)).endsWith("Did you read them?"), true);
});
}

for (const mode of ["ok", "fail"] as const) {
  test(`compaction keeps the todo list and later requests extend it (summary call ${mode === "ok" ? "succeeds" : "fails"})`, async () => {
    summaryMode = mode;
    const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "pruning");
    const conversation = await agentRuntimeManager.createConversation(workspace, {
      backendId: "cesium-agent",
      modelId: MODEL_ID,
      modelName: "Tiny",
    });
    const firstRequest = agentRequests.length;
    const firstSummary = summaryRequests.length;
    scripted.push(
      readTurn(`call_${mode}_read`, "one.txt", 4_000),
      toolTurn(`call_${mode}_todo`, "todo", { action: "replace", items: [{ content: "Explain one.txt", status: "in_progress" }] }, 7_000),
      textTurn("one.txt lists six hundred lines.", 8_000)
    );
    await agentRuntimeManager.promptConversation(workspace, conversation.id, "Read one.txt and track it.");
    await waitForIdle(workspace.id, conversation.id, 1);
    scripted.push(textTurn("It has six hundred lines.", 15_000));
    await agentRuntimeManager.promptConversation(workspace, conversation.id, "How long is it?");
    await waitForIdle(workspace.id, conversation.id, 2);
    scripted.push(textTurn("Still six hundred.", 6_000));
    await agentRuntimeManager.promptConversation(workspace, conversation.id, "And now?");
    await waitForIdle(workspace.id, conversation.id, 3);
    scripted.push(textTurn("Yes.", 6_200));
    await agentRuntimeManager.promptConversation(workspace, conversation.id, "Sure?");
    const snapshot = await waitForIdle(workspace.id, conversation.id, 4);

    const summary = snapshot.events.find(
      (event): event is Extract<AgentStoredEvent, { kind: "compression_summary" }> =>
        event.kind === "compression_summary" && Boolean(event.sourceRange)
    );
    assert.ok(summary, "the third turn compacts the first");
    assert.equal(summaryRequests.length - firstSummary, 1, "one summary call per compaction");
    assert.equal((summary.raw as { summaryKind?: string }).summaryKind, mode === "ok" ? "model" : "structured");
    if (mode === "ok") {
      assert.ok(summary.summary.startsWith(MODEL_SUMMARY));
    } else {
      assert.match(summary.summary, /^## Original request\nRead one\.txt and track it\./);
      assert.match(summary.summary, /## Files touched\n- one\.txt \(read\)/);
    }
    assert.match(summary.summary, /## Current todo list\n- \[in_progress\] Explain one\.txt$/);

    const requests = agentRequests.slice(firstRequest).map((request) => request.messages);
    assert.equal(requests.length, 6);
    const compactedRequest = requests[4]!;
    assert.equal(messageText(compactedRequest[1]), `[Compressed earlier conversation]\n${summary.summary}`);
    assert.deepEqual(requests[5]!.slice(0, compactedRequest.length), compactedRequest, "the next turn extends the compacted request");
  });
}

test("pruned-output summaries parse from a fenced reply, keep asked ids only and stay one capped line", async () => {
  const { parsePruneSummaries, CESIUM_PRUNE_SUMMARY_MAX_CHARS } = await import(
    "../src/lib/agents/cesium/cesium-context-pruning.js"
  );
  const long = "word ".repeat(200);
  const reply = `Sure.\n\`\`\`json\n${JSON.stringify({ a: "line one\n  line two", b: long, c: "unasked", d: 4 })}\n\`\`\``;
  const parsed = parsePruneSummaries(reply, ["a", "b", "d", "missing"]);
  assert.deepEqual(Object.keys(parsed), ["a", "b"]);
  assert.equal(parsed.a, "line one line two");
  assert.equal(parsed.b!.length, CESIUM_PRUNE_SUMMARY_MAX_CHARS);
  assert.ok(parsed.b!.endsWith("…"));
  assert.deepEqual(parsePruneSummaries("no json here", ["a"]), {});
  assert.deepEqual(parsePruneSummaries("{not json}", ["a"]), {});
});
