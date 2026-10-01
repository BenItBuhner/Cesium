import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";

const run = promisify(execFile);
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(SERVER_DIR, "test", "fixtures", "cross-process-conversation.ts");
const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-cross-process-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "cross");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

type ChatMessage = { role: string; content?: unknown };
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[] };
const requests: ChatRequest[] = [];

function sse(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Cross Process" } }] }));
      return;
    }
    requests.push(body);
    sse(res, `Reply ${requests.length}.`);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of ["REDIS_URL", "DATABASE_URL", "OPENCURSOR_STORAGE_DRIVER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CESIUM_MODELS", "OPENCURSOR_TITLE_MODEL"]) {
  delete env[key];
}
Object.assign(env, {
  NODE_ENV: "test",
  OPENCURSOR_DATA_DIR: TEST_DATA_DIR,
  CESIUM_BASE_URL: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
  CESIUM_API_KEY: "sk-test-cross",
  CESIUM_PROVIDER_ID: "crosshost",
  CESIUM_DEFAULT_MODEL: "kimi-k3",
  CESIUM_TEST_MODEL_ID: "crosshost/kimi-k3",
});

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

/** Runs the helper in its own Node process, as one server process would. */
async function inNewProcess(args: string[], extraEnv: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", HELPER, ...args], {
    cwd: SERVER_DIR,
    env: { ...env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = stdout.trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1);
  return JSON.parse(line ?? "{}") as Record<string, string | null>;
}

const text = (message: ChatMessage | undefined) => (typeof message?.content === "string" ? message.content : "");

for (const variant of [
  { name: "exits right after creating it", settleMs: "0" },
  { name: "lets the creation warmup finish", settleMs: "1500" },
]) {
  test(`a conversation created in one process and run in another (the first ${variant.name}) sends the user's message, as a pure append`, async () => {
    const created = await inNewProcess(["create", WORKSPACE_ROOT], { CESIUM_TEST_SETTLE_MS: variant.settleMs });
    const conversationId = created.conversationId!;

    const firstTurnStart = requests.length;
    await inNewProcess(["prompt", WORKSPACE_ROOT, conversationId, "Hello from the second process."]);
    const firstTurn = requests.slice(firstTurnStart);
    assert.equal(firstTurn.length, 1);
    const sent = firstTurn[0]!.messages;
    const lastUser = sent.filter((message) => message.role === "user").at(-1);
    assert.match(text(lastUser), /Hello from the second process\.$/, "the user's message reaches the model");
    assert.doesNotMatch(JSON.stringify(sent), /could not be resumed|recovered_conversation/, "no recovery seed on a first turn");
    assert.equal(
      sent.filter((message) => /Hello from the second process\./.test(text(message))).length,
      1,
      "the user's message is sent once"
    );

    const secondTurnStart = requests.length;
    await inNewProcess(["prompt", WORKSPACE_ROOT, conversationId, "And from a third."]);
    const secondTurn = requests.slice(secondTurnStart);
    assert.equal(secondTurn.length, 1);
    assert.deepEqual(secondTurn[0]!.tools, firstTurn[0]!.tools, "the tool block survives the restart");
    assert.deepEqual(
      secondTurn[0]!.messages.slice(0, sent.length),
      sent,
      "the turn after the next restart extends the first turn's request byte for byte"
    );
  });
}
