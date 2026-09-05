import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import {
  OPENCODE_GENERATION_OPTION_ID,
  parseOpenCodeGeneration,
  resolveOpenCodeGeneration,
  withOpenCodeGenerationOption,
  type OpenCodeGeneration,
} from "./opencode-generation.js";
import { createOpenCodeServerProvider } from "./opencode-server-provider.js";
import { createOpenCodeV2Provider } from "./opencode-v2-provider.js";
import { harnessLog } from "./harness-diagnostics.js";

type DialectStart = (
  callbacks: AgentRuntimeCallbacks,
  generation: OpenCodeGeneration
) => Promise<AgentSessionHandle>;

/**
 * Handle that fronts whichever dialect (Current `opencode serve` or v2 Beta
 * `opencode2 serve`) the conversation currently selects. The runtime applies
 * option changes to the live handle, and the two servers keep separate session
 * stores, so switching `generation` mid-conversation must tear the inner
 * session down and start one on the other server - simply storing the option
 * would leave the chat silently running on the old dialect.
 */
class OpenCodeSwitchingHandle implements AgentSessionHandle {
  private switching: Promise<void> | null = null;

  constructor(
    private inner: AgentSessionHandle,
    private generation: OpenCodeGeneration,
    private readonly callbacks: AgentRuntimeCallbacks,
    private readonly startDialect: DialectStart
  ) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get configOptions(): AgentConfigOption[] {
    return this.inner.configOptions;
  }

  get capabilities(): AgentProviderCapabilities {
    return this.inner.capabilities;
  }

  get pause(): AgentSessionHandle["pause"] {
    const target = this.inner.pause;
    return target ? () => target.call(this.inner) : undefined;
  }

  get resume(): AgentSessionHandle["resume"] {
    const target = this.inner.resume;
    return target ? () => target.call(this.inner) : undefined;
  }

  get answerQuestion(): AgentSessionHandle["answerQuestion"] {
    const target = this.inner.answerQuestion;
    return target ? (input) => target.call(this.inner, input) : undefined;
  }

  async prompt(input: Parameters<AgentSessionHandle["prompt"]>[0]): Promise<void> {
    await this.switching;
    return this.inner.prompt(input);
  }

  async cancel(): Promise<void> {
    await this.switching;
    return this.inner.cancel();
  }

  async answerPermission(input: Parameters<AgentSessionHandle["answerPermission"]>[0]): Promise<void> {
    await this.switching;
    return this.inner.answerPermission(input);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    await this.switching;
    const requested =
      configId === OPENCODE_GENERATION_OPTION_ID ? parseOpenCodeGeneration(value) : undefined;
    if (!requested || requested === this.generation) {
      return this.inner.setConfigOption(configId, value);
    }
    this.switching = this.switchGeneration(requested);
    try {
      await this.switching;
    } finally {
      this.switching = null;
    }
  }

  async dispose(): Promise<void> {
    await this.switching?.catch(() => undefined);
    return this.inner.dispose();
  }

  private async switchGeneration(next: OpenCodeGeneration): Promise<void> {
    const previous = this.generation;
    const options = withOpenCodeGenerationOption(this.inner.configOptions, next);
    harnessLog({
      backendId: "opencode-server",
      conversationId: this.callbacks.conversation.id,
      event: "generation.switch",
      detail: `Switching OpenCode dialect ${previous} -> ${next}; starting a fresh ${next} session.`,
    });
    await this.inner.dispose().catch(() => undefined);
    // The new dialect reads the generation from the conversation record, and its
    // session id belongs to the other server, so clear it before starting.
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: options,
      providerSessionId: null,
      status: "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
    try {
      this.inner = await this.startDialect(this.callbacks, next);
      this.generation = next;
    } catch (error) {
      harnessLog({
        level: "error",
        backendId: "opencode-server",
        conversationId: this.callbacks.conversation.id,
        event: "generation.switch_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      // Fall back to the previous dialect so the chat keeps working.
      await this.callbacks.updateConversation((current) => ({
        ...current,
        configOptions: withOpenCodeGenerationOption(current.configOptions, previous),
        providerSessionId: null,
      }));
      this.inner = await this.startDialect(this.callbacks, previous);
      throw error;
    }
  }
}

/**
 * Single OpenCode harness entry. The conversation's `generation` option (or
 * env / legacy v2 backend id) picks the Current vs v2 Beta HTTP dialect.
 */
export function createOpenCodeProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  const resolveGeneration = (callbacks: AgentRuntimeCallbacks): OpenCodeGeneration =>
    resolveOpenCodeGeneration({
      options:
        callbacks.conversation.configOptions.length > 0
          ? callbacks.conversation.configOptions
          : input.configOptions,
      backendId: callbacks.conversation.config.backendId,
    });
  const createDialect = (callbacks: AgentRuntimeCallbacks, generation: OpenCodeGeneration) => {
    const configOptions = withOpenCodeGenerationOption(
      callbacks.conversation.configOptions.length > 0
        ? callbacks.conversation.configOptions
        : input.configOptions,
      generation
    );
    const backend: AgentBackendInfo = {
      ...input.backend,
      id: "opencode-server",
    };
    if (generation === "v2-beta") {
      return createOpenCodeV2Provider({ backend, configOptions });
    }
    return createOpenCodeServerProvider({ backend, configOptions });
  };
  const startDialect: DialectStart = async (callbacks, generation) =>
    createDialect(callbacks, generation).startSession(callbacks);

  return {
    backend: input.backend,
    async startSession(callbacks) {
      const generation = resolveGeneration(callbacks);
      const inner = await startDialect(callbacks, generation);
      return new OpenCodeSwitchingHandle(inner, generation, callbacks, startDialect);
    },
    async loadSession(callbacks, providerSessionId) {
      const generation = resolveGeneration(callbacks);
      const inner = await createDialect(callbacks, generation).loadSession(callbacks, providerSessionId);
      return new OpenCodeSwitchingHandle(inner, generation, callbacks, startDialect);
    },
  };
}
