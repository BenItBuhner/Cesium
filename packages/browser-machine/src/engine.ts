/**
 * The in-page Cesium engine: VFS + stores + route shims + virtual sockets,
 * assembled behind the same `/api` + `/ws` surface as the Bun engine.
 */
import { EngineRouter } from "./http";
import { EngineSocketHub, BrowserMachineWebSocket, type EngineSocketChannel, type EngineSocketContext } from "./sockets";
import { Vfs } from "./vfs";
import { WorkspaceStore } from "./stores/workspaces";
import { SessionStore } from "./stores/sessions";
import { ConversationStore } from "./stores/conversations";
import { SettingsStore } from "./stores/settings";
import { registerCoreRoutes } from "./routes/core-routes";
import { registerFsRoutes } from "./routes/fs-routes";
import { registerWorkspaceRoutes } from "./routes/workspace-routes";
import { registerAgentRoutes } from "./routes/agent-routes";
import { registerSettingsRoutes } from "./routes/settings-routes";
import { registerGitRoutes } from "./git/git-routes";
import { FsChannelHub } from "./channels/fs-channel";
import { AgentChannelHub } from "./channels/agent-channel";
import { TerminalChannelHub } from "./channels/terminal-channel";
import { BrowserAgentHarness } from "./harness/runtime";
import { BrowserGit } from "./git/browser-git";
import { ShellRuntime } from "./shell/runtime";
import { registerTerminalRoutes } from "./routes/terminal-routes";

export class BrowserMachineEngine {
  readonly router = new EngineRouter();
  readonly socketHub = new EngineSocketHub();
  readonly vfs = new Vfs();
  readonly workspaces = new WorkspaceStore(this.vfs);
  readonly sessions = new SessionStore();
  readonly conversations = new ConversationStore();
  readonly settings = new SettingsStore();
  readonly git = new BrowserGit(this.vfs);
  readonly shell = new ShellRuntime(this.vfs, this.git);
  readonly harness = new BrowserAgentHarness({
    vfs: this.vfs,
    conversations: this.conversations,
    settings: this.settings,
    git: this.git,
    shell: this.shell,
  });
  private fsChannels!: FsChannelHub;
  private agentChannels!: AgentChannelHub;
  private terminalChannels!: TerminalChannelHub;

  private constructor() {}

  static async create(): Promise<BrowserMachineEngine> {
    const engine = new BrowserMachineEngine();
    await engine.vfs.hydrate();
    if (!engine.vfs.exists("/workspaces")) {
      engine.vfs.mkdir("/workspaces", { recursive: true });
    }
    engine.fsChannels = new FsChannelHub(engine.vfs, engine.workspaces);
    engine.agentChannels = new AgentChannelHub(engine.conversations);
    engine.terminalChannels = new TerminalChannelHub(engine.shell, engine.workspaces);

    registerCoreRoutes(engine.router);
    registerFsRoutes(engine.router, { vfs: engine.vfs, workspaces: engine.workspaces });
    registerWorkspaceRoutes(engine.router, {
      vfs: engine.vfs,
      workspaces: engine.workspaces,
      sessions: engine.sessions,
      gitStatus: (workspace) => engine.git.status(workspace),
      gitInit: (workspace) => engine.git.init(workspace),
      gitSwitch: (workspace, branch) => engine.git.switchBranch(workspace, branch),
      clone: (input) => engine.git.clone(input),
      buildRepositoriesByWorkspace: async (workspaces) => {
        const result: Record<string, unknown> = {};
        for (const workspace of workspaces) {
          result[workspace.id] = await engine.git.railRepositoryInfo(workspace);
        }
        return result;
      },
    });
    registerAgentRoutes(engine.router, {
      vfs: engine.vfs,
      workspaces: engine.workspaces,
      conversations: engine.conversations,
      settings: engine.settings,
      runtime: () => engine.harness,
    });
    registerSettingsRoutes(engine.router, { settings: engine.settings });
    registerGitRoutes(engine.router, {
      git: engine.git,
      workspaces: engine.workspaces,
    });
    registerTerminalRoutes(engine.router, engine.terminalChannels, engine.workspaces);

    engine.socketHub.registerPrefix("/ws/agent", (url, context) =>
      engine.agentChannels.createChannel(url, context)
    );
    engine.socketHub.registerPrefix("/ws/terminal", (url, context) =>
      engine.terminalChannels.createChannel(url, context)
    );

    return engine;
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.router.dispatch(path, init);
  }

  openSocketChannel(
    url: URL,
    context: EngineSocketContext
  ): Promise<EngineSocketChannel | null> | EngineSocketChannel | null {
    if (url.pathname === "/ws/fs") {
      return this.fsChannels.createChannel(url, context);
    }
    return this.socketHub.createChannel(url, context);
  }
}

let enginePromise: Promise<BrowserMachineEngine> | null = null;

export function getBrowserMachineEngine(): Promise<BrowserMachineEngine> {
  if (!enginePromise) {
    enginePromise = BrowserMachineEngine.create();
  }
  return enginePromise;
}

export type BrowserMachineTransport = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openSocket(url: string): BrowserMachineWebSocket;
};

export function createBrowserMachineTransport(): BrowserMachineTransport {
  return {
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const engine = await getBrowserMachineEngine();
      return engine.fetch(path, init);
    },
    openSocket(url: string): BrowserMachineWebSocket {
      return new BrowserMachineWebSocket(url, async (socket) => {
        const engine = await getBrowserMachineEngine();
        const parsed = new URL(url.replace(/^ws/, "http"));
        const context: EngineSocketContext = {
          send: (message) => socket.deliver(message),
          close: () => socket.closeFromEngine(),
        };
        return engine.openSocketChannel(parsed, context);
      });
    },
  };
}
