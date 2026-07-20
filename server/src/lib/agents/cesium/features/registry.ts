import type {
  CesiumFeatureCatalogEntry,
  CesiumFeatureDefinition,
  CesiumFeatureModule,
  CesiumHarnessFeatureId,
  CesiumHarnessLimits,
  CesiumHarnessSettings,
} from "./types.js";

export type CesiumFeatureRegistry = {
  register: (definition: CesiumFeatureDefinition) => () => void;
  list: () => CesiumFeatureDefinition[];
  catalog: () => CesiumFeatureCatalogEntry[];
  resolve: (
    settings: CesiumHarnessSettings,
    limits: CesiumHarnessLimits
  ) => CesiumFeatureModule[];
};

function validateDefinition(definition: CesiumFeatureDefinition): void {
  if (!definition.id.trim()) {
    throw new Error("Cesium feature id must not be empty.");
  }
  if (definition.versions.length === 0) {
    throw new Error(`Cesium feature "${definition.id}" must provide at least one version.`);
  }
  const versions = new Set<number>();
  for (const implementation of definition.versions) {
    if (!Number.isInteger(implementation.version) || implementation.version < 1) {
      throw new Error(
        `Cesium feature "${definition.id}" has invalid version ${implementation.version}.`
      );
    }
    if (versions.has(implementation.version)) {
      throw new Error(
        `Cesium feature "${definition.id}" registers version ${implementation.version} more than once.`
      );
    }
    versions.add(implementation.version);
  }
  if (!versions.has(definition.defaultVersion)) {
    throw new Error(
      `Cesium feature "${definition.id}" default version ${definition.defaultVersion} is not registered.`
    );
  }
}

export function createCesiumFeatureRegistry(
  initialDefinitions: readonly CesiumFeatureDefinition[] = []
): CesiumFeatureRegistry {
  const definitions = new Map<CesiumHarnessFeatureId, CesiumFeatureDefinition>();

  const register = (definition: CesiumFeatureDefinition): (() => void) => {
    validateDefinition(definition);
    if (definitions.has(definition.id)) {
      throw new Error(`Cesium feature "${definition.id}" is already registered.`);
    }
    definitions.set(definition.id, definition);
    return () => {
      if (definitions.get(definition.id) === definition) {
        definitions.delete(definition.id);
      }
    };
  };

  for (const definition of initialDefinitions) {
    register(definition);
  }

  const list = (): CesiumFeatureDefinition[] => [...definitions.values()];

  return {
    register,
    list,
    catalog: () =>
      list().map((definition) => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        defaultVersion: definition.defaultVersion,
        versions: definition.versions.map((version) => ({
          version: version.version,
          label: version.label,
          description: version.description,
        })),
      })),
    resolve: (settings, limits) =>
      list().map((definition) => {
        const requestedVersion =
          settings.features[definition.id]?.version ?? definition.defaultVersion;
        const implementation =
          definition.versions.find((entry) => entry.version === requestedVersion) ??
          definition.versions.find((entry) => entry.version === definition.defaultVersion)!;
        const featureModule = implementation.resolve(limits);
        if (
          featureModule.id !== definition.id ||
          featureModule.version !== implementation.version
        ) {
          throw new Error(
            `Cesium feature "${definition.id}" v${implementation.version} resolved mismatched module "${featureModule.id}" v${featureModule.version}.`
          );
        }
        return featureModule;
      }),
  };
}
