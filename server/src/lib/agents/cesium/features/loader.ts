import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CesiumFeatureRegistry } from "./registry.js";
import type { CesiumHarnessPluginDefinition } from "./types.js";

export type LoadedCesiumHarnessPluginModule = {
  specifier: string;
  pluginIds: string[];
  unload: () => void;
};

const loadedModulesByRegistry = new WeakMap<
  CesiumFeatureRegistry,
  Map<string, LoadedCesiumHarnessPluginModule>
>();
const allLoadedModules = new Set<LoadedCesiumHarnessPluginModule>();

function parseModuleSpecifiers(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error("CESIUM_HARNESS_PLUGIN_MODULES JSON must be an array of strings.");
    }
    return parsed.map((entry) => entry.trim()).filter(Boolean);
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function resolveSpecifier(specifier: string, workspaceRoot: string): string {
  if (specifier.startsWith("file:")) return specifier;
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/")
  ) {
    const absolute = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(workspaceRoot, specifier);
    return pathToFileURL(absolute).href;
  }
  return specifier;
}

function pluginDefinitionsFromModule(
  moduleValue: Record<string, unknown>,
  specifier: string
): CesiumHarnessPluginDefinition[] {
  const candidates = [
    moduleValue.cesiumHarnessPlugins,
    moduleValue.cesiumHarnessPlugin,
    moduleValue.default,
  ];
  const definitions = [
    ...new Set(
      candidates.flatMap((candidate) =>
        Array.isArray(candidate) ? candidate : candidate ? [candidate] : []
      )
    ),
  ];
  if (definitions.length === 0) {
    throw new Error(
      `Cesium harness plugin module "${specifier}" must export default, cesiumHarnessPlugin, or cesiumHarnessPlugins.`
    );
  }
  return definitions as CesiumHarnessPluginDefinition[];
}

/**
 * Load executable harness plugins from explicit module specifiers.
 *
 * This is intentionally opt-in because modules execute with server privileges.
 * Use CESIUM_HARNESS_PLUGIN_MODULES as a comma list or JSON string array.
 */
export async function loadCesiumHarnessPluginModules(
  specifiers: readonly string[],
  registry: CesiumFeatureRegistry,
  workspaceRoot: string
): Promise<LoadedCesiumHarnessPluginModule[]> {
  let loadedModules = loadedModulesByRegistry.get(registry);
  if (!loadedModules) {
    loadedModules = new Map();
    loadedModulesByRegistry.set(registry, loadedModules);
  }
  const results: LoadedCesiumHarnessPluginModule[] = [];
  for (const rawSpecifier of specifiers) {
    const specifier = resolveSpecifier(rawSpecifier, workspaceRoot);
    const existing = loadedModules.get(specifier);
    if (existing) {
      results.push(existing);
      continue;
    }
    const imported = (await import(specifier)) as Record<string, unknown>;
    const definitions = pluginDefinitionsFromModule(imported, specifier);
    const unregister: Array<() => void> = [];
    try {
      for (const definition of definitions) {
        unregister.push(registry.register(definition));
      }
    } catch (error) {
      for (const remove of unregister.reverse()) remove();
      throw error;
    }
    const loaded: LoadedCesiumHarnessPluginModule = {
      specifier,
      pluginIds: definitions.map((definition) => definition.id),
      unload: () => {
        for (const remove of [...unregister].reverse()) remove();
        loadedModules.delete(specifier);
        allLoadedModules.delete(loaded);
      },
    };
    loadedModules.set(specifier, loaded);
    allLoadedModules.add(loaded);
    results.push(loaded);
  }
  return results;
}

export async function loadCesiumHarnessPluginModulesFromEnv(
  registry: CesiumFeatureRegistry,
  workspaceRoot: string
): Promise<LoadedCesiumHarnessPluginModule[]> {
  return loadCesiumHarnessPluginModules(
    parseModuleSpecifiers(process.env.CESIUM_HARNESS_PLUGIN_MODULES),
    registry,
    workspaceRoot
  );
}

export function resetLoadedCesiumHarnessPluginModulesForTests(): void {
  for (const loaded of [...allLoadedModules].reverse()) {
    loaded.unload();
  }
}
