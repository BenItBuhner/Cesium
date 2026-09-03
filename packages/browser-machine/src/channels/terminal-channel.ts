/**
 * Virtual `/ws/terminal/:id` channel backed by ShellSession line-discipline
 * (no PTY in the browser; interactive enough for real work).
 */
import type { EngineSocketChannel, EngineSocketContext } from "../sockets";
import type { ShellRuntime, ShellSession } from "../shell/runtime";
import { ShellSession as ShellSessionImpl } from "../shell/runtime";
import type { WorkspaceStore } from "../stores/workspaces";

export type TerminalRecord = {
  id: string;
  workspaceId: string;
  cwd: string;
  session: ShellSession | null;
  attachedClients: number;
  alive: boolean;
  scrollback: string;
};

/** Chunks that would JSON-parse into scalars get dropped by the client's
 * Binary socket string handling; an SGR reset prefix keeps them strings. */
function safeChunk(chunk: string): string {
  try {
    const parsed = JSON.parse(chunk) as unknown;
    if (typeof parsed === "object" && parsed !== null) return chunk;
    return `\u001b[0m${chunk}`;
  } catch {
    return chunk;
  }
}

export class TerminalChannelHub {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly shell: ShellRuntime,
    private readonly workspaces: WorkspaceStore
  ) {}

  list(workspaceId: string | null): TerminalRecord[] {
    return [...this.terminals.values()].filter(
      (terminal) => !workspaceId || terminal.workspaceId === workspaceId
    );
  }

  async create(workspaceId: string): Promise<TerminalRecord> {
    const workspace = await this.workspaces.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    const record: TerminalRecord = {
      id: crypto.randomUUID(),
      workspaceId,
      cwd: workspace.root,
      session: null,
      attachedClients: 0,
      alive: true,
      scrollback: "",
    };
    this.terminals.set(record.id, record);
    return record;
  }

  kill(terminalId: string): boolean {
    const record = this.terminals.get(terminalId);
    if (!record) return false;
    record.session?.dispose();
    record.alive = false;
    this.terminals.delete(terminalId);
    return true;
  }

  createChannel(url: URL, context: EngineSocketContext): EngineSocketChannel | null {
    const terminalId = url.pathname.split("/").pop() ?? "";
    const record = this.terminals.get(terminalId);
    if (!record) return null;

    record.attachedClients += 1;
    context.send({ type: "metadata", clearCommands: ["clear", "cls"] });
    if (record.scrollback) {
      context.send(safeChunk(record.scrollback));
    }
    const sink = (chunk: string): void => {
      record.scrollback = (record.scrollback + chunk).slice(-100_000);
      context.send(safeChunk(chunk));
    };
    if (!record.session) {
      record.session = new ShellSessionImpl(this.shell, {
        cwd: record.cwd,
        onOutput: sink,
      });
      record.session.start();
    } else {
      record.session.setOutput(sink);
    }

    return {
      onClientMessage: (raw) => {
        try {
          const message = JSON.parse(raw) as { type?: string };
          if (message.type === "resize" || message.type === "clear") {
            if (message.type === "clear") {
              record.scrollback = "";
            }
            return;
          }
        } catch {
          // Raw keystrokes.
        }
        record.session?.write(raw);
      },
      onClose: () => {
        record.attachedClients = Math.max(0, record.attachedClients - 1);
      },
    };
  }
}
