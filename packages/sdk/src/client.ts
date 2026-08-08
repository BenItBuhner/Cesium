import {
  ActionsResource,
  AgentsResource,
  AuthResource,
  CloudAgentsResource,
  SettingsResource,
  StorageResource,
  SystemResource,
  WorkspaceResource,
  WorkspacesResource,
} from "./resources.js";
import {
  CesiumTransport,
  type CesiumClientOptions,
  type CesiumRequestOptions,
  type RuntimeSchema,
} from "./transport.js";

export class CesiumClient {
  readonly system: SystemResource;
  readonly auth: AuthResource;
  readonly workspaces: WorkspacesResource;
  readonly agents: AgentsResource;
  readonly settings: SettingsResource;
  readonly cloudAgents: CloudAgentsResource;
  readonly storage: StorageResource;
  readonly actions: ActionsResource;

  private readonly transport: CesiumTransport;
  private readonly workspaceClients = new Map<string, WorkspaceResource>();

  constructor(options: CesiumClientOptions) {
    this.transport = new CesiumTransport(options);
    this.system = new SystemResource(this.transport);
    this.auth = new AuthResource(this.transport);
    this.workspaces = new WorkspacesResource(this.transport);
    this.agents = new AgentsResource(this.transport);
    this.settings = new SettingsResource(this.transport);
    this.cloudAgents = new CloudAgentsResource(this.transport);
    this.storage = new StorageResource(this.transport);
    this.actions = new ActionsResource(this.transport);
  }

  /**
   * Return an immutable, workspace-scoped SDK surface. Multiple workspaces can
   * be used concurrently without changing global client state.
   */
  workspace(workspaceId: string): WorkspaceResource {
    const normalized = workspaceId.trim();
    if (!normalized) {
      throw new Error("workspaceId is required.");
    }
    let resource = this.workspaceClients.get(normalized);
    if (!resource) {
      resource = new WorkspaceResource(normalized, this.transport);
      this.workspaceClients.set(normalized, resource);
    }
    return resource;
  }

  /**
   * Typed escape hatch for endpoints that have not yet received a named
   * resource method. Named methods remain preferable because they validate
   * stable response contracts.
   */
  request<T>(
    path: string,
    options?: CesiumRequestOptions & { schema?: RuntimeSchema<T> }
  ): Promise<T> {
    return this.transport.request("custom request", path, options);
  }

  raw(path: string, options?: CesiumRequestOptions): Promise<Response> {
    return this.transport.raw(path, options);
  }
}

export function createCesiumClient(options: CesiumClientOptions): CesiumClient {
  return new CesiumClient(options);
}
