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
  revision: () => number;
  resolve: (
    settings: CesiumHarnessSettings,
    limits: CesiumHarnessLimits
  ) => CesiumFeatureModule[];
};

function validateDefinition(definition: CesiumFeatureDefinition): void {
  if (!definition.id.trim()) {
    throw new Error("Cesium feature id must not be empty.");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(definition.id)) {
    throw new Error(
      `Cesium feature id "${definition.id}" must contain only letters, numbers, dots, underscores, and hyphens.`
    );
  }
  if (definition.apiVersion != null && definition.apiVersion !== 1) {
    throw new Error(
      `Cesium feature "${definition.id}" uses unsupported plugin API version ${definition.apiVersion}.`
    );
  }
  if (
    definition.priority != null &&
    (!Number.isFinite(definition.priority) || !Number.isInteger(definition.priority))
  ) {
    throw new Error(`Cesium feature "${definition.id}" priority must be an integer.`);
  }
  const dependencies = [
    ...(definition.dependencies ?? []),
    ...(definition.optionalDependencies ?? []),
  ];
  if (dependencies.includes(definition.id)) {
    throw new Error(`Cesium feature "${definition.id}" cannot depend on itself.`);
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error(`Cesium feature "${definition.id}" declares a dependency more than once.`);
  }
  const declaredToolNames = definition.toolNames ?? [];
  if (
    new Set(declaredToolNames).size !== declaredToolNames.length ||
    declaredToolNames.some((name) => !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(name))
  ) {
    throw new Error(
      `Cesium feature "${definition.id}" toolNames must be unique valid tool identifiers.`
    );
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
  const registrationOrder = new Map<CesiumHarnessFeatureId, number>();
  let nextRegistrationOrder = 0;
  let currentRevision = 0;

  const register = (definition: CesiumFeatureDefinition): (() => void) => {
    validateDefinition(definition);
    if (definitions.has(definition.id)) {
      throw new Error(`Cesium feature "${definition.id}" is already registered.`);
    }
    definitions.set(definition.id, definition);
    registrationOrder.set(definition.id, nextRegistrationOrder++);
    currentRevision += 1;
    return () => {
      if (definitions.get(definition.id) === definition) {
        definitions.delete(definition.id);
        registrationOrder.delete(definition.id);
        currentRevision += 1;
      }
    };
  };

  for (const definition of initialDefinitions) {
    register(definition);
  }

  const list = (): CesiumFeatureDefinition[] => [...definitions.values()];

  const compareDefinitions = (
    left: CesiumFeatureDefinition,
    right: CesiumFeatureDefinition
  ): number => {
    const byPriority = (left.priority ?? 0) - (right.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    const byRegistration =
      (registrationOrder.get(left.id) ?? 0) - (registrationOrder.get(right.id) ?? 0);
    if (byRegistration !== 0) return byRegistration;
    return left.id.localeCompare(right.id);
  };

  const resolveOrder = (settings: CesiumHarnessSettings): CesiumFeatureDefinition[] => {
    const enabled = list().filter((definition) => {
      const selection = settings.features[definition.id];
      return selection?.enabled ?? definition.enabledByDefault ?? true;
    });
    const enabledIds = new Set(enabled.map((definition) => definition.id));
    for (const definition of enabled) {
      for (const dependency of definition.dependencies ?? []) {
        if (!definitions.has(dependency)) {
          throw new Error(
            `Cesium harness plugin "${definition.id}" requires missing plugin "${dependency}".`
          );
        }
        if (!enabledIds.has(dependency)) {
          throw new Error(
            `Cesium harness plugin "${definition.id}" requires disabled plugin "${dependency}".`
          );
        }
      }
    }

    const incoming = new Map(enabled.map((definition) => [definition.id, 0]));
    const outgoing = new Map(enabled.map((definition) => [definition.id, [] as string[]]));
    for (const definition of enabled) {
      const dependencies = [
        ...(definition.dependencies ?? []),
        ...(definition.optionalDependencies ?? []).filter((id) => enabledIds.has(id)),
      ];
      for (const dependency of dependencies) {
        outgoing.get(dependency)?.push(definition.id);
        incoming.set(definition.id, (incoming.get(definition.id) ?? 0) + 1);
      }
    }

    const ready = enabled
      .filter((definition) => incoming.get(definition.id) === 0)
      .sort(compareDefinitions);
    const ordered: CesiumFeatureDefinition[] = [];
    while (ready.length > 0) {
      const definition = ready.shift()!;
      ordered.push(definition);
      for (const dependentId of outgoing.get(definition.id) ?? []) {
        const count = (incoming.get(dependentId) ?? 1) - 1;
        incoming.set(dependentId, count);
        if (count === 0) {
          const dependent = definitions.get(dependentId);
          if (dependent) {
            ready.push(dependent);
            ready.sort(compareDefinitions);
          }
        }
      }
    }
    if (ordered.length !== enabled.length) {
      const cycle = enabled
        .filter((definition) => (incoming.get(definition.id) ?? 0) > 0)
        .map((definition) => definition.id)
        .sort();
      throw new Error(`Cesium harness plugin dependency cycle: ${cycle.join(" -> ")}.`);
    }
    return ordered;
  };

  return {
    register,
    list,
    revision: () => currentRevision,
    catalog: () =>
      list().map((definition) => ({
        apiVersion: definition.apiVersion ?? 1,
        id: definition.id,
        label: definition.label,
        description: definition.description,
        defaultVersion: definition.defaultVersion,
        enabledByDefault: definition.enabledByDefault ?? true,
        priority: definition.priority ?? 0,
        dependencies: [...(definition.dependencies ?? [])],
        optionalDependencies: [...(definition.optionalDependencies ?? [])],
        failureMode: definition.failureMode ?? "isolate",
        toolNames: [...(definition.toolNames ?? [])],
        versions: definition.versions.map((version) => ({
          version: version.version,
          label: version.label,
          description: version.description,
        })),
      })),
    resolve: (settings, limits) =>
      resolveOrder(settings).map((definition) => {
        const selection = settings.features[definition.id];
        const requestedVersion =
          selection?.version ?? definition.defaultVersion;
        const implementation =
          definition.versions.find((entry) => entry.version === requestedVersion) ??
          definition.versions.find((entry) => entry.version === definition.defaultVersion)!;
        const config = Object.freeze({ ...(selection?.config ?? {}) });
        const featureModule = implementation.resolve({
          ...limits,
          settings,
          pluginId: definition.id,
          config,
        });
        if (
          featureModule.id !== definition.id ||
          featureModule.version !== implementation.version
        ) {
          throw new Error(
            `Cesium feature "${definition.id}" v${implementation.version} resolved mismatched module "${featureModule.id}" v${featureModule.version}.`
          );
        }
        if (
          definition.toolNames &&
          featureModule.toolNames.some(
            (name) => !definition.toolNames!.includes(name)
          )
        ) {
          throw new Error(
            `Cesium feature "${definition.id}" v${implementation.version} contributes a tool not declared in its definition toolNames.`
          );
        }
        const declaredToolNames = new Set(featureModule.toolNames);
        const contributedToolNames = new Set(
          featureModule.tools.map((tool) => tool.name)
        );
        if (
          declaredToolNames.size !== contributedToolNames.size ||
          [...declaredToolNames].some((name) => !contributedToolNames.has(name))
        ) {
          throw new Error(
            `Cesium feature "${definition.id}" v${implementation.version} toolNames must exactly match its contributed tools.`
          );
        }
        return {
          ...featureModule,
          priority: definition.priority ?? featureModule.priority ?? 0,
          failureMode:
            featureModule.failureMode ?? definition.failureMode ?? "isolate",
          config,
        };
      }),
  };
}
