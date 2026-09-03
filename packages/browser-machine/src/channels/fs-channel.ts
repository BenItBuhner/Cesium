/**
 * Virtual `/ws/fs` channel: replays the same `workspace_snapshot` / `ready`
 * handshake and sequenced add/change/unlink frames as the engine's chokidar
 * watcher, but sourced from VFS mutation events.
 */
import type { WorkspaceRecord } from "@cesium/core";
import type { EngineSocketChannel, EngineSocketContext } from "../sockets";
import { toRelativePath } from "../paths";
import type { Vfs, VfsChange } from "../vfs";
import type { WorkspaceStore } from "../stores/workspaces";

type SequencedFsEvent =
  | { type: "add"; seq: number; path: string; isDir: false }
  | { type: "addDir"; seq: number; path: string; isDir: true }
  | { type: "change"; seq: number; path: string }
  | { type: "unlink"; seq: number; path: string; isDir: false }
  | { type: "unlinkDir"; seq: number; path: string; isDir: true };

type Room = {
  workspace: WorkspaceRecord;
  nextSeq: number;
  buffered: SequencedFsEvent[];
  clients: Set<EngineSocketContext>;
};

const MAX_BUFFERED_EVENTS = 500;

export class FsChannelHub {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly vfs: Vfs,
    private readonly workspaces: WorkspaceStore
  ) {
    this.vfs.onChanges((changes) => this.onVfsChanges(changes));
  }

  private onVfsChanges(changes: VfsChange[]): void {
    for (const room of this.rooms.values()) {
      for (const change of changes) {
        const root = room.workspace.root;
        if (change.path !== root && !change.path.startsWith(`${root}/`)) continue;
        const relativePath = toRelativePath(root, change.path);
        if (!relativePath) continue;
        const seq = room.nextSeq;
        room.nextSeq += 1;
        const event: SequencedFsEvent =
          change.kind === "addDir" || change.kind === "unlinkDir"
            ? { type: change.kind, seq, path: relativePath, isDir: true }
            : change.kind === "change"
              ? { type: "change", seq, path: relativePath }
              : { type: change.kind, seq, path: relativePath, isDir: false };
        room.buffered.push(event);
        while (room.buffered.length > MAX_BUFFERED_EVENTS) {
          room.buffered.shift();
        }
        for (const client of room.clients) {
          client.send(event);
        }
      }
    }
  }

  async createChannel(
    url: URL,
    context: EngineSocketContext
  ): Promise<EngineSocketChannel | null> {
    const workspaceId = url.searchParams.get("workspaceId")?.trim();
    if (!workspaceId) return null;
    const workspace = await this.workspaces.getById(workspaceId);
    if (!workspace) return null;

    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = { workspace, nextSeq: 1, buffered: [], clients: new Set() };
      this.rooms.set(workspaceId, room);
    }
    room.clients.add(context);

    const latestSeq = room.nextSeq - 1;
    context.send({
      type: "workspace_snapshot",
      workspaceId,
      root: workspace.root,
      name: workspace.name,
      latestSeq,
    });
    const sinceRaw = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    if (since > 0 && since < latestSeq) {
      const firstBuffered = room.buffered[0]?.seq ?? latestSeq + 1;
      if (since >= firstBuffered - 1) {
        for (const event of room.buffered) {
          if (event.seq > since) context.send(event);
        }
      } else {
        context.send({ type: "resync_required", latestSeq });
      }
    }
    context.send({ type: "ready", latestSeq });

    const activeRoom = room;
    return {
      onClientMessage: (raw) => {
        try {
          const message = JSON.parse(raw) as { type?: string };
          if (message.type === "ping") {
            context.send({ type: "pong", latestSeq: activeRoom.nextSeq - 1 });
          }
        } catch {
          // Ignore malformed frames.
        }
      },
      onClose: () => {
        activeRoom.clients.delete(context);
      },
    };
  }
}
