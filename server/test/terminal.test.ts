import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import {
  createTerminalSession,
  handleTerminalUpgrade,
  killTerminalSession,
  listTerminalSessions,
} from "../src/ws/terminal.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((chunk) =>
        chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk)
      )
    ).toString("utf8");
  }
  return data.toString("utf8");
}

async function waitForOutput(readOutput: () => string, text: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(text)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for terminal output: ${text}`);
}

async function connectTerminal(baseUrl: string, terminalId: string) {
  const chunks: string[] = [];
  const ws = new WebSocket(`${baseUrl}/ws/terminal/${terminalId}`);

  ws.on("message", (data) => {
    chunks.push(rawDataToString(data));
  });

  await once(ws, "open");

  return {
    ws,
    readOutput: () => chunks.join(""),
  };
}

test("terminal sessions survive detach until explicitly killed", async (t) => {
  const workspaceId = "workspace-under-test";
  const { id: terminalId } = createTerminalSession(workspaceId, repoRoot);

  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/ws/terminal/")) {
      handleTerminalUpgrade(
        request,
        socket,
        head,
        url.pathname.slice("/ws/terminal/".length)
      );
      return;
    }
    socket.destroy();
  });

  t.after(async () => {
    const sessions = listTerminalSessions();
    if (sessions.some((session) => session.id === terminalId)) {
      killTerminalSession(terminalId);
    }

    server.close();
    await once(server, "close");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port for terminal test.");
  }

  const baseUrl = `ws://127.0.0.1:${address.port}`;

  const firstConnection = await connectTerminal(baseUrl, terminalId);
  await delay(100);
  assert.equal(
    listTerminalSessions().find((session) => session.id === terminalId)?.attachedClients,
    1
  );

  firstConnection.ws.send(
    Buffer.from('export TEST_PERSIST=alive; printf "__SET__\\n"\n', "utf8")
  );
  await waitForOutput(firstConnection.readOutput, "__SET__");

  firstConnection.ws.close();
  await once(firstConnection.ws, "close");
  await delay(1100);

  const detachedSession = listTerminalSessions().find((session) => session.id === terminalId);
  assert.ok(detachedSession, "expected detached terminal to remain listed");
  assert.equal(detachedSession.attachedClients, 0);

  const secondConnection = await connectTerminal(baseUrl, terminalId);
  secondConnection.ws.send(
    Buffer.from('printf "%s\\n" "$TEST_PERSIST"\n', "utf8")
  );
  await waitForOutput(secondConnection.readOutput, "alive");

  secondConnection.ws.close();
  await once(secondConnection.ws, "close");

  assert.equal(killTerminalSession(terminalId), true);
  assert.equal(
    listTerminalSessions().some((session) => session.id === terminalId),
    false
  );
});
