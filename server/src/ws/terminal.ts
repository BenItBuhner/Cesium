import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { spawnPty, type PtyProcess } from "../lib/pty.js";
import { type RuntimeSocket, wrapNodeWebSocket } from "./runtime-socket.js";

type TerminalSession = {
  id: string;
  workspaceId: string;
  pty: PtyProcess;
  shell: string;
  cwd: string;
  clearCommands: string[];
  createdAt: number;
  attachedClients: Set<RuntimeSocket>;
  exited: boolean;
  exitCode: number | null;
  scrollbackChunks: Buffer[];
  scrollbackSize: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const terminalSessions = new Map<string, TerminalSession>();
const terminalWebSocketServer = new WebSocketServer({ noServer: true });
const TERMINAL_SCROLLBACK_LIMIT = 50 * 1024;

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return (
      process.env.PWSH ??
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      )
    );
  }
  return process.env.SHELL ?? "/bin/bash";
}

function getShellBaseName(shell: string): string {
  return path.basename(shell).toLowerCase();
}

function getDefaultClearCommands(shell: string): string[] {
  const shellName = getShellBaseName(shell);

  if (
    shellName === "powershell.exe" ||
    shellName === "powershell" ||
    shellName === "pwsh.exe" ||
    shellName === "pwsh"
  ) {
    return ["clear", "cls", "clear-host"];
  }

  if (shellName === "cmd.exe" || shellName === "cmd") {
    return ["cls"];
  }

  return ["clear", "reset"];
}

function mergeClearCommands(...commandGroups: string[][]): string[] {
  return [...new Set(commandGroups.flat().map((command) => command.trim().toLowerCase()).filter(Boolean))];
}

async function resolvePowerShellClearCommands(shell: string): Promise<string[]> {
  const shellName = getShellBaseName(shell);
  if (
    shellName !== "powershell.exe" &&
    shellName !== "powershell" &&
    shellName !== "pwsh.exe" &&
    shellName !== "pwsh"
  ) {
    return getDefaultClearCommands(shell);
  }

  const script = [
    "$commands = @('clear', 'cls', 'clear-host')",
    "try {",
    "  $commands += Get-Alias | Where-Object { $_.Definition -eq 'Clear-Host' } | Select-Object -ExpandProperty Name",
    "} catch {}",
    "$commands | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique",
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-NoLogo", "-Command", script],
      {
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(
          mergeClearCommands(
            getDefaultClearCommands(shell),
            stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          )
        );
      }
    );
  });
}

function sendSessionEvent(
  session: TerminalSession,
  payload:
    | { type: "exit"; code: number | null }
    | { type: "pong" }
    | { type: "metadata"; shell: string; clearCommands: string[] }
): void {
  const message = JSON.stringify(payload);
  for (const client of session.attachedClients) {
    if (client.isOpen) {
      client.send(message);
    }
  }
}

function clearSessionScrollback(session: TerminalSession): void {
  session.scrollbackChunks = [];
  session.scrollbackSize = 0;
}

function hydrateSessionClearCommands(session: TerminalSession): void {
  void resolvePowerShellClearCommands(session.shell)
    .then((clearCommands) => {
      const merged = mergeClearCommands(session.clearCommands, clearCommands);
      if (
        merged.length === session.clearCommands.length &&
        merged.every((command, index) => command === session.clearCommands[index])
      ) {
        return;
      }

      session.clearCommands = merged;
      sendSessionEvent(session, {
        type: "metadata",
        shell: session.shell,
        clearCommands: session.clearCommands,
      });
    })
    .catch(() => {
      // Ignore metadata enrichment failures and stick to shell defaults.
    });
}

function appendScrollback(session: TerminalSession, chunk: Buffer): void {
  if (chunk.length === 0) return;
  session.scrollbackChunks.push(chunk);
  session.scrollbackSize += chunk.length;

  while (
    session.scrollbackChunks.length > 0 &&
    session.scrollbackSize > TERMINAL_SCROLLBACK_LIMIT
  ) {
    const removed = session.scrollbackChunks.shift();
    if (!removed) break;
    session.scrollbackSize -= removed.length;
  }
}

function spawnTerminalSession(
  workspaceId: string,
  cwd: string,
  shell = getDefaultShell()
): TerminalSession {
  const id = randomUUID();
  const ptyProcess = spawnPty({
    file: shell,
    args: [],
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: process.env,
  });

  const session: TerminalSession = {
    id,
    workspaceId,
    pty: ptyProcess,
    shell,
    cwd,
    clearCommands: getDefaultClearCommands(shell),
    createdAt: Date.now(),
    attachedClients: new Set(),
    exited: false,
    exitCode: null,
    scrollbackChunks: [],
    scrollbackSize: 0,
  };

  ptyProcess.onData((data) => {
    const chunk = Buffer.from(data, "utf8");
    appendScrollback(session, chunk);
    for (const client of session.attachedClients) {
      if (client.isOpen) {
        client.send(chunk, { binary: true });
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    sendSessionEvent(session, { type: "exit", code: exitCode });
    terminalSessions.delete(session.id);
  });

  terminalSessions.set(session.id, session);
  hydrateSessionClearCommands(session);
  return session;
}

export function createTerminalSession(
  workspaceId: string,
  cwd: string,
  shell?: string
): { id: string } {
  const session = spawnTerminalSession(workspaceId, cwd, shell);
  return { id: session.id };
}

export function listTerminalSessions(): Array<{
  workspaceId: string;
  id: string;
  shell: string;
  cwd: string;
  alive: boolean;
  attachedClients: number;
}> {
  return [...terminalSessions.values()].map((session) => ({
    workspaceId: session.workspaceId,
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    alive: !session.exited,
    attachedClients: session.attachedClients.size,
  }));
}

export function killTerminalSession(id: string): boolean {
  const session = terminalSessions.get(id);
  if (!session) return false;
  session.pty.kill();
  terminalSessions.delete(id);
  return true;
}

function attachTerminalClient(session: TerminalSession, ws: RuntimeSocket): void {
  session.attachedClients.add(ws);

  ws.send(
    JSON.stringify({
      type: "metadata",
      shell: session.shell,
      clearCommands: session.clearCommands,
    })
  );

  if (session.scrollbackChunks.length > 0) {
    ws.send(Buffer.concat(session.scrollbackChunks), { binary: true });
  }

  if (session.exited) {
    ws.send(JSON.stringify({ type: "exit", code: session.exitCode }));
    return;
  }

  ws.onMessage((data, isBinary) => {
    if (isBinary) {
      session.pty.write(decoder.decode(data as Buffer));
      return;
    }

    try {
      const message = JSON.parse(data.toString()) as
        | { type: "resize"; cols: number; rows: number }
        | { type: "ping" }
        | { type: "clear" };

      if (message.type === "resize") {
        session.pty.resize(message.cols, message.rows);
        return;
      }

      if (message.type === "clear") {
        clearSessionScrollback(session);
        return;
      }

      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // Ignore malformed control messages.
    }
  });

  ws.onClose(() => {
    session.attachedClients.delete(ws);
  });
}

export function attachTerminalSocket(ws: RuntimeSocket, terminalId: string): void {
  const session = terminalSessions.get(terminalId);
  if (!session) {
    ws.close(1008, "Terminal session not found");
    return;
  }
  attachTerminalClient(session, ws);
}

export function handleTerminalUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  terminalId: string
): void {
  const session = terminalSessions.get(terminalId);
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  terminalWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
    attachTerminalClient(session, wrapNodeWebSocket(ws));
  });
}

export function encodeTerminalInput(data: string): Buffer {
  return Buffer.from(encoder.encode(data));
}
