import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentProvider,
  AgentRuntimeCallbacks,
} from "./types.js";
import {
  resolveOpenCodeGeneration,
  withOpenCodeGenerationOption,
} from "./opencode-generation.js";
import { createOpenCodeServerProvider } from "./opencode-server-provider.js";
import { createOpenCodeV2Provider } from "./opencode-v2-provider.js";

/**
 * Single OpenCode harness entry. The conversation's `generation` option (or
 * env / legacy v2 backend id) picks the Current vs v2 Beta HTTP dialect.
 */
export function createOpenCodeProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  const createDialect = async (callbacks: AgentRuntimeCallbacks) => {
    const generation = resolveOpenCodeGeneration({
      options:
        callbacks.conversation.configOptions.length > 0
          ? callbacks.conversation.configOptions
          : input.configOptions,
      backendId: callbacks.conversation.config.backendId,
    });
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

  return {
    backend: input.backend,
    async startSession(callbacks) {
      const provider = await createDialect(callbacks);
      return provider.startSession(callbacks);
    },
    async loadSession(callbacks, providerSessionId) {
      const provider = await createDialect(callbacks);
      return provider.loadSession(callbacks, providerSessionId);
    },
  };
}
