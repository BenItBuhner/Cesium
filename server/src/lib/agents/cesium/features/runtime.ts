import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
  CesiumToolRequest,
} from "../cesium-types.js";
import type {
  CesiumFeatureModule,
  CesiumHarnessModelRequest,
  CesiumHarnessPluginContext,
  CesiumHarnessTurnInput,
  CesiumHarnessTurnOutcome,
} from "./types.js";

export type CesiumHarnessPluginDiagnostic = {
  pluginId: string;
  pluginVersion: number;
  hook: string;
  message: string;
  createdAt: number;
};

export type CesiumHarnessPluginRuntimeContext = Omit<
  CesiumHarnessPluginContext,
  "pluginId" | "pluginVersion" | "config"
>;

export type CesiumHarnessPluginRuntimeOptions = {
  modules: CesiumFeatureModule[];
  context: () => CesiumHarnessPluginRuntimeContext;
  hookTimeoutMs?: number;
  onDiagnostic?: (diagnostic: CesiumHarnessPluginDiagnostic) => void | Promise<void>;
};

const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTICS = 100;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
        timeoutMs
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function validateToolRequest(value: unknown, previous: CesiumToolRequest): CesiumToolRequest {
  if (!value || typeof value !== "object") {
    throw new Error("beforeTool must return a tool request object.");
  }
  const request = value as CesiumToolRequest;
  if (request.id !== previous.id) {
    throw new Error("beforeTool cannot change a tool request id.");
  }
  if (typeof request.name !== "string" || !request.name.trim()) {
    throw new Error("beforeTool returned an invalid tool name.");
  }
  if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
    throw new Error("beforeTool returned invalid tool arguments.");
  }
  return request;
}

function validateMessages(value: unknown): CesiumHistoryMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("transformMessages must return an array.");
  }
  for (const message of value) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant", "tool"].includes(
        String((message as CesiumHistoryMessage).role)
      ) ||
      typeof (message as CesiumHistoryMessage).content !== "string"
    ) {
      throw new Error("transformMessages returned an invalid history message.");
    }
  }
  return value as CesiumHistoryMessage[];
}

/**
 * Per-session execution host for resolved harness plugins.
 *
 * Hooks run sequentially in dependency/priority order. Failures are isolated
 * by default, recorded as bounded diagnostics, and optionally surfaced by the
 * host. A plugin can opt into fatal failures for enforcement-oriented hooks.
 */
export class CesiumHarnessPluginRuntime {
  private readonly modules: CesiumFeatureModule[];
  private readonly hookTimeoutMs: number;
  private readonly diagnostics: CesiumHarnessPluginDiagnostic[] = [];
  private started = false;
  private disposed = false;

  constructor(private readonly options: CesiumHarnessPluginRuntimeOptions) {
    this.modules = [...options.modules];
    this.hookTimeoutMs = Math.max(
      1,
      Math.min(
        60_000,
        Math.floor(options.hookTimeoutMs ?? DEFAULT_PLUGIN_HOOK_TIMEOUT_MS)
      )
    );
  }

  listDiagnostics(): CesiumHarnessPluginDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  private context(module: CesiumFeatureModule): CesiumHarnessPluginContext {
    return {
      ...this.options.context(),
      pluginId: module.id,
      pluginVersion: module.version,
      config: module.config ?? {},
    };
  }

  private async report(
    module: CesiumFeatureModule,
    hook: string,
    error: unknown
  ): Promise<never | void> {
    const normalized = asError(error);
    const diagnostic: CesiumHarnessPluginDiagnostic = {
      pluginId: module.id,
      pluginVersion: module.version,
      hook,
      message: normalized.message,
      createdAt: Date.now(),
    };
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
    }
    await this.options.onDiagnostic?.(diagnostic);
    if (module.failureMode === "fatal") {
      throw new Error(
        `Cesium harness plugin "${module.id}" failed in ${hook}: ${normalized.message}`,
        { cause: normalized }
      );
    }
  }

  private async invoke(
    module: CesiumFeatureModule,
    hook: string,
    operation: () => unknown | Promise<unknown>
  ): Promise<unknown> {
    try {
      return await withTimeout(
        Promise.resolve().then(operation),
        this.hookTimeoutMs,
        `Cesium harness plugin "${module.id}" hook ${hook}`
      );
    } catch (error) {
      await this.report(module, hook, error);
      return undefined;
    }
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const module of this.modules) {
      const hook = module.hooks?.onSessionStart;
      if (hook) {
        await this.invoke(module, "onSessionStart", () => hook(this.context(module)));
      }
    }
  }

  async turnStart(input: CesiumHarnessTurnInput): Promise<CesiumHarnessTurnInput> {
    let current = input;
    for (const module of this.modules) {
      const hook = module.hooks?.onTurnStart;
      if (!hook) continue;
      const next = await this.invoke(module, "onTurnStart", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        if (!next || typeof next !== "object" || typeof (next as CesiumHarnessTurnInput).text !== "string") {
          await this.report(module, "onTurnStart", new Error("onTurnStart returned an invalid turn input."));
          continue;
        }
        current = next as CesiumHarnessTurnInput;
      }
    }
    return current;
  }

  async transformSystemPrompt(prompt: string): Promise<string> {
    let current = prompt;
    for (const module of this.modules) {
      const hook = module.hooks?.transformSystemPrompt;
      if (!hook) continue;
      const next = await this.invoke(module, "transformSystemPrompt", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        if (typeof next !== "string") {
          await this.report(
            module,
            "transformSystemPrompt",
            new Error("transformSystemPrompt must return a string.")
          );
          continue;
        }
        current = next;
      }
    }
    return current;
  }

  async transformMessages(messages: CesiumHistoryMessage[]): Promise<CesiumHistoryMessage[]> {
    let current = messages;
    for (const module of this.modules) {
      const hook = module.hooks?.transformMessages;
      if (!hook) continue;
      const next = await this.invoke(module, "transformMessages", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        try {
          current = validateMessages(next);
        } catch (error) {
          await this.report(module, "transformMessages", error);
        }
      }
    }
    return current;
  }

  async beforeModel(request: CesiumHarnessModelRequest): Promise<CesiumHarnessModelRequest> {
    let current = request;
    for (const module of this.modules) {
      const hook = module.hooks?.beforeModel;
      if (!hook) continue;
      const next = await this.invoke(module, "beforeModel", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        const candidate = next as CesiumHarnessModelRequest;
        if (
          !next ||
          typeof next !== "object" ||
          candidate.modelId !== current.modelId ||
          candidate.iteration !== current.iteration ||
          !Array.isArray(candidate.messages) ||
          !Array.isArray(candidate.tools)
        ) {
          await this.report(module, "beforeModel", new Error("beforeModel returned an invalid model request."));
          continue;
        }
        try {
          current = {
            ...candidate,
            messages: validateMessages(candidate.messages),
          };
        } catch (error) {
          await this.report(module, "beforeModel", error);
        }
      }
    }
    return current;
  }

  async afterModel(result: CesiumAdapterResult): Promise<CesiumAdapterResult> {
    let current = result;
    for (const module of this.modules) {
      const hook = module.hooks?.afterModel;
      if (!hook) continue;
      const next = await this.invoke(module, "afterModel", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        if (!next || typeof next !== "object" || !Array.isArray((next as CesiumAdapterResult).toolRequests)) {
          await this.report(module, "afterModel", new Error("afterModel returned an invalid adapter result."));
          continue;
        }
        current = next as CesiumAdapterResult;
      }
    }
    return current;
  }

  async beforeTool(request: CesiumToolRequest): Promise<CesiumToolRequest> {
    let current = request;
    for (const module of this.modules) {
      const hook = module.hooks?.beforeTool;
      if (!hook) continue;
      const next = await this.invoke(module, "beforeTool", () =>
        hook(this.context(module), current)
      );
      if (next !== undefined) {
        try {
          current = validateToolRequest(next, current);
        } catch (error) {
          await this.report(module, "beforeTool", error);
        }
      }
    }
    return current;
  }

  async afterTool(request: CesiumToolRequest, result: string): Promise<string> {
    let current = result;
    for (const module of this.modules) {
      const hook = module.hooks?.afterTool;
      if (!hook) continue;
      const next = await this.invoke(module, "afterTool", () =>
        hook(this.context(module), request, current)
      );
      if (next !== undefined) {
        if (typeof next !== "string") {
          await this.report(module, "afterTool", new Error("afterTool must return a string."));
          continue;
        }
        current = next;
      }
    }
    return current;
  }

  async toolError(request: CesiumToolRequest, error: unknown): Promise<void> {
    const normalized = asError(error);
    for (const module of this.modules) {
      const hook = module.hooks?.onToolError;
      if (hook) {
        await this.invoke(module, "onToolError", () =>
          hook(this.context(module), request, normalized)
        );
      }
    }
  }

  async turnEnd(outcome: CesiumHarnessTurnOutcome): Promise<void> {
    for (const module of [...this.modules].reverse()) {
      const hook = module.hooks?.onTurnEnd;
      if (hook) {
        await this.invoke(module, "onTurnEnd", () =>
          hook(this.context(module), outcome)
        );
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const module of [...this.modules].reverse()) {
      const hook = module.hooks?.onSessionDispose;
      if (hook) {
        await this.invoke(module, "onSessionDispose", () =>
          hook(this.context(module))
        );
      }
    }
  }
}
