import assert from "node:assert/strict";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-terminal-runs-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
  { resolveCesiumTools, resolveCesiumToolPermissionCategory, toolKind, toolTitle, cesiumPermissionToolKey },
  { SUBAGENT_SHARED_HOST_TOOL_NAMES },
  { readTerminalRunRecord, readTerminalLogSlice, terminalRunsDir },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
  import("../src/lib/agents/cesium/subagent-toolset.js"),
  import("../src/lib/agents/cesium/cesium-terminal-runs.js"),
]);

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const WORKSPACE_ID = "ws-terminal-runs";
const posixOnly = { skip: process.platform === "win32" ? "process groups are POSIX-only" : false };
const linuxOnly = { skip: process.platform !== "linux" ? "reads /proc" : false };

type TerminalHandle = {
  toolTerminal: (args: Record<string, unknown>) => Promise<string>;
  toolTerminalRead: (args: Record<string, unknown>) => Promise<string>;
  toolTerminalKill: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

async function startSession(conversationId: string): Promise<TerminalHandle> {
  const backend = AGENT_BACKENDS["cesium-agent"]!;
  const provider = await createCesiumAgentProvider({ backend });
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: conversationId,
    workspaceId: WORKSPACE_ID,
    title: "Terminal runs test",
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
    workspace: { id: WORKSPACE_ID, root: TEST_DATA_DIR, name: "terminal", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });
  return handle as unknown as TerminalHandle;
}

function runIdFrom(result: string): string {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(result);
  assert.ok(match, `expected a run id in: ${result.slice(0, 200)}`);
  return match[0];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids whose process group is `pgid` (Linux /proc). */
function processGroupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // fields[0] is state (field 3); fields[2] is pgrp (field 5). Zombies are already dead.
      if (Number(fields[2]) === pgid && fields[0] !== "Z") members.push(Number(name));
    } catch {
      // Exited while scanning.
    }
  }
  return members;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function writeNodeScript(name: string, source: string): Promise<string> {
  const scriptPath = path.join(TEST_DATA_DIR, name);
  await fs.writeFile(scriptPath, source, "utf8");
  return `"${process.execPath}" "${scriptPath}"`;
}

test("terminal_read returns the output and exit code of a command that outlived its timeout", async () => {
  const handle = await startSession("conv-terminal-read");
  try {
    const command = await writeNodeScript(
      "slow.cjs",
      [
        `process.stdout.write("FIRST_LINE\\n");`,
        `setTimeout(() => { process.stdout.write("SECOND_LINE\\n"); process.exit(3); }, 2500);`,
      ].join("\n")
    );
    const first = await handle.toolTerminal({ command, timeoutMs: 1000 });
    assert.match(first, /^Command still running after 1000ms as /);
    assert.ok(first.includes("FIRST_LINE"), first);
    assert.match(first, /terminal_read \{ "id": "[^"]+", "since": \d+ \}/);
    const id = runIdFrom(first);

    const running = await handle.toolTerminalRead({ id });
    assert.match(running, new RegExp(`^Terminal run ${id} is running \\(pid \\d+\\)\\.`));

    let final = "";
    assert.ok(
      await waitFor(async () => {
        final = await handle.toolTerminalRead({ id });
        return final.includes("exited 3");
      }, 10_000),
      `run never reported its exit: ${final}`
    );
    assert.ok(final.includes("FIRST_LINE") && final.includes("SECOND_LINE"), final);
    const next = Number(/pass since: (\d+)/.exec(final)?.[1]);
    assert.ok(next > 0, final);

    const tail = await handle.toolTerminalRead({ id, since: next });
    assert.match(tail, /exited 3\./);
    assert.match(tail, new RegExp(`No output after byte ${next}\\.`));

    const partial = await handle.toolTerminalRead({ id, since: "FIRST_LINE\n".length });
    assert.ok(!partial.includes("FIRST_LINE") && partial.includes("SECOND_LINE"), partial);

    await assert.rejects(handle.toolTerminalRead({ id: "not-a-run" }), /No terminal run not-a-run/);
    await assert.rejects(handle.toolTerminalRead({}), /terminal_read\.id is required/);
  } finally {
    await handle.dispose();
  }
});

test("terminal_kill ends the whole process group, not just the shell", linuxOnly, async () => {
  const handle = await startSession("conv-terminal-kill");
  try {
    const started = await handle.toolTerminal({
      command: "sleep 101 & sleep 102 & echo CHILDREN_UP; wait",
      waitUntil: "pattern",
      pattern: "CHILDREN_UP",
      timeoutMs: 10_000,
    });
    assert.match(started, /^Pattern matched for .* \(still running as /);
    const id = runIdFrom(started);
    const record = await readTerminalRunRecord(WORKSPACE_ID, id);
    assert.ok(record?.pid, "the run record keeps the shell pid");
    const members = processGroupMembers(record!.pid!);
    assert.ok(members.length >= 3, `expected the shell plus two sleeps, got ${members.join(",")}`);

    const killed = await handle.toolTerminalKill({ id });
    assert.match(killed, /Killed terminal run .* and its process group\./);
    assert.ok(
      await waitFor(() => members.every((pid) => !isAlive(pid) || !processGroupMembers(record!.pid!).includes(pid)), 5_000),
      `children survived: ${processGroupMembers(record!.pid!).join(",")}`
    );
    assert.match(await handle.toolTerminalRead({ id }), /terminated by SIGTERM/);
    assert.match(await handle.toolTerminalKill({ id }), /is not running; it terminated by SIGTERM/);
  } finally {
    await handle.dispose();
  }
});

test("dispose kills background runs together with the processes they spawned", linuxOnly, async () => {
  const handle = await startSession("conv-terminal-dispose");
  const started = await handle.toolTerminal({
    command: "sleep 103 & echo SPAWNED; wait",
    waitUntil: "background",
  });
  const id = runIdFrom(started);
  const record = await readTerminalRunRecord(WORKSPACE_ID, id);
  assert.ok(record?.pid);
  assert.ok(await waitFor(() => processGroupMembers(record!.pid!).length >= 2, 5_000));
  await handle.dispose();
  assert.ok(
    await waitFor(() => processGroupMembers(record!.pid!).length === 0, 6_000),
    `group survived dispose: ${processGroupMembers(record!.pid!).join(",")}`
  );
});

test("run records persist so a restarted session can still read and kill a run", posixOnly, async () => {
  const conversationId = "conv-terminal-restart";
  const before = await startSession(conversationId);
  const finished = await before.toolTerminal({ command: "echo PERSISTED_OUTPUT; exit 4", timeoutMs: 10_000 });
  assert.match(finished, /^Command exited 4\./);
  const background = await before.toolTerminal({
    command: "echo LONG_RUNNING_UP; sleep 104",
    waitUntil: "background",
  });
  const backgroundId = runIdFrom(background);

  const files = await fs.readdir(terminalRunsDir(WORKSPACE_ID));
  assert.ok(files.includes(`${backgroundId}.json`) && files.includes(`${backgroundId}.log`), files.join(","));
  const record = await readTerminalRunRecord(WORKSPACE_ID, backgroundId);
  assert.equal(record?.command, "echo LONG_RUNNING_UP; sleep 104");
  assert.equal(record?.cwd, TEST_DATA_DIR);
  assert.equal(record?.conversationId, conversationId);
  assert.equal(typeof record?.startedAt, "number");
  assert.ok(record?.pid && record.pid > 0);

  // A second handle for the same conversation stands in for the server after a restart.
  const after = await startSession(conversationId);
  const other = await startSession("conv-terminal-other");
  try {
    const finishedId = await (async () => {
      for (const name of files.filter((file) => file.endsWith(".json"))) {
        const candidate = await readTerminalRunRecord(WORKSPACE_ID, name.slice(0, -5));
        if (candidate?.command.startsWith("echo PERSISTED_OUTPUT")) return candidate.id;
      }
      throw new Error("finished run record missing");
    })();
    const replay = await after.toolTerminalRead({ id: finishedId });
    assert.match(replay, /exited 4\./);
    assert.ok(replay.includes("PERSISTED_OUTPUT"), replay);

    assert.ok(
      await waitFor(async () => (await after.toolTerminalRead({ id: backgroundId })).includes("LONG_RUNNING_UP"), 5_000)
    );
    assert.match(
      await after.toolTerminalRead({ id: backgroundId }),
      /is running \(pid \d+; started before the server restarted/
    );
    await assert.rejects(
      other.toolTerminalRead({ id: backgroundId }),
      /No terminal run .* in this conversation/,
      "runs are scoped to the conversation that started them"
    );

    assert.match(await after.toolTerminalKill({ id: backgroundId }), /Killed terminal run/);
    assert.ok(await waitFor(() => !isAlive(record!.pid!), 5_000), "restarted session killed the run");
    const persisted = await readTerminalRunRecord(WORKSPACE_ID, backgroundId);
    assert.equal(persisted?.signal, "SIGTERM");
    assert.equal(typeof persisted?.completedAt, "number");
  } finally {
    await other.dispose();
    await after.dispose();
    await before.dispose();
  }
});

test("readTerminalLogSlice keeps head and tail of an oversized range", async () => {
  const logFile = path.join(TEST_DATA_DIR, "slice.log");
  await fs.writeFile(logFile, `HEAD${"x".repeat(5_000)}TAIL`, "utf8");
  const slice = await readTerminalLogSlice(logFile, 0, 100);
  assert.ok(slice.text.startsWith("HEAD") && slice.text.endsWith("TAIL"), slice.text);
  assert.match(slice.text, /\.\.\.\[truncated \d+ chars from the middle\]\.\.\./);
  assert.equal(slice.end, 5_008);
  const beyond = await readTerminalLogSlice(logFile, 99_999, 100);
  assert.equal(beyond.start, 5_008);
  assert.equal(beyond.text, "");
});

test("terminal_read is read-only while terminal_kill needs terminal permission", () => {
  const tools = resolveCesiumTools().tools;
  assert.ok(tools.some((tool) => tool.name === "terminal_read"));
  assert.equal(resolveCesiumToolPermissionCategory(tools, "terminal_read"), undefined);
  assert.equal(resolveCesiumToolPermissionCategory(tools, "terminal_kill"), "terminal");
  assert.equal(toolKind("terminal_read"), "terminal");
  assert.equal(toolKind("terminal_kill"), "terminal");
  assert.equal(toolTitle("terminal_kill", { id: "0123456789abcdef" }), "Kill terminal 01234567");
  assert.equal(
    cesiumPermissionToolKey("terminal", { killRunId: "abc", command: "npm run dev" }),
    "cesium:terminal_kill:npm run dev"
  );
  assert.equal(cesiumPermissionToolKey("terminal", { command: "npm run dev" }), "cesium:terminal:npm run dev");
  const terminal = tools.find((tool) => tool.name === "terminal");
  assert.match(terminal!.description, /terminal_read/);
  assert.match(terminal!.description, /terminal_kill/);
  assert.ok(SUBAGENT_SHARED_HOST_TOOL_NAMES.includes("terminal_read"));
  assert.ok(SUBAGENT_SHARED_HOST_TOOL_NAMES.includes("terminal_kill"));
});
