/**
 * Global + Cesium Agent settings persisted in IndexedDB. The Cesium Agent
 * settings mirror the engine's `cesium-agent-settings.json`: an OpenAI-style
 * provider list with API keys, a model catalog, and a default model id.
 * API keys never leave the browser (they are stored locally and used for
 * direct provider calls from the page).
 */
import type { CesiumModelCatalogEntry, CesiumProviderKind } from "@cesium/core";
import { CESIUM_DEFAULT_MODEL_ID, CESIUM_DEFAULT_MODEL_NAME } from "@cesium/core";
import { readDoc, writeDoc } from "./kv-docs";

const GLOBAL_SETTINGS_KEY = "settings:global";
const CESIUM_AGENT_SETTINGS_KEY = "settings:cesium-agent";

export type StoredProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: CesiumProviderKind;
  apiKey?: string;
  models: CesiumModelCatalogEntry[];
};

export type CesiumAgentStoredSettings = {
  defaultModelId: string | null;
  providers: StoredProvider[];
};

export class SettingsStore {
  async getGlobalSettings(): Promise<Record<string, unknown>> {
    return (await readDoc<Record<string, unknown>>(GLOBAL_SETTINGS_KEY)) ?? {};
  }

  async putGlobalSettings(settings: Record<string, unknown>): Promise<void> {
    await writeDoc(GLOBAL_SETTINGS_KEY, settings);
  }

  async getCesiumAgentSettings(): Promise<CesiumAgentStoredSettings> {
    return (
      (await readDoc<CesiumAgentStoredSettings>(CESIUM_AGENT_SETTINGS_KEY)) ?? {
        defaultModelId: null,
        providers: [],
      }
    );
  }

  async putCesiumAgentSettings(settings: CesiumAgentStoredSettings): Promise<void> {
    await writeDoc(CESIUM_AGENT_SETTINGS_KEY, settings);
  }

  /** Flattened model catalog across providers. */
  async listModels(): Promise<CesiumModelCatalogEntry[]> {
    const settings = await this.getCesiumAgentSettings();
    return settings.providers.flatMap((provider) => provider.models);
  }

  async resolveDefaultModel(): Promise<{ modelId: string; modelName: string }> {
    const settings = await this.getCesiumAgentSettings();
    const models = settings.providers.flatMap((provider) => provider.models);
    const configured = settings.defaultModelId
      ? models.find(
          (model) =>
            model.modelId === settings.defaultModelId ||
            `${model.providerId}/${model.modelId}` === settings.defaultModelId
        )
      : null;
    if (configured) {
      return {
        modelId: `${configured.providerId}/${configured.modelId}`,
        modelName: configured.modelName,
      };
    }
    const first = models[0];
    if (first) {
      return {
        modelId: `${first.providerId}/${first.modelId}`,
        modelName: first.modelName,
      };
    }
    return { modelId: CESIUM_DEFAULT_MODEL_ID, modelName: CESIUM_DEFAULT_MODEL_NAME };
  }

  /**
   * Resolve provider + credentials for a conversation model id of the form
   * `providerId/modelId` (falling back to catalog search by bare model id).
   */
  async resolveModelAuth(modelId: string): Promise<{
    provider: StoredProvider;
    model: CesiumModelCatalogEntry;
  } | null> {
    const settings = await this.getCesiumAgentSettings();
    const slash = modelId.indexOf("/");
    if (slash > 0) {
      const providerId = modelId.slice(0, slash);
      const bareModelId = modelId.slice(slash + 1);
      const provider = settings.providers.find((entry) => entry.id === providerId);
      const model = provider?.models.find((entry) => entry.modelId === bareModelId);
      if (provider && model) {
        return { provider, model };
      }
    }
    for (const provider of settings.providers) {
      const model = provider.models.find((entry) => entry.modelId === modelId);
      if (model) {
        return { provider, model };
      }
    }
    return null;
  }
}
