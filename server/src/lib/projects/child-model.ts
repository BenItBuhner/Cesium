import {
  getCesiumAgentSettings,
  listCesiumAgentModelRoster,
  listCredentialedCesiumProviderIds,
} from "../cesium-agent-settings.js";
import { ProjectError } from "./errors.js";

/**
 * Project agents only start on models their engine can actually call. The
 * Cesium Agent is the one harness whose provider keys this engine owns, so it
 * is the one checked here; other harnesses keep their own model handling (an
 * unavailable harness is already refused by `resolveHarness`).
 */

const CESIUM_HARNESS_ID = "cesium-agent";
const LISTED_MODELS_MAX = 12;

export type ChildModelChoice = {
  /** Model to start the agent on; null keeps the harness default. */
  modelId: string | null;
  /** Why a different model than the requested or default one was picked. */
  warning: string | null;
};

type CesiumModelAccess = {
  /** Tool-capable, enabled roster models whose provider has a credential. */
  runnable: string[];
  credentialedProviders: Set<string>;
  engineDefault: string;
};

type ModelCheck = { modelId: string } | { reason: string };

async function loadCesiumModelAccess(): Promise<CesiumModelAccess> {
  const settings = await getCesiumAgentSettings();
  const [roster, credentialedProviders] = await Promise.all([
    listCesiumAgentModelRoster({ credentialedOnly: true }),
    listCredentialedCesiumProviderIds(settings),
  ]);
  return {
    runnable: roster.map((entry) => entry.modelId),
    credentialedProviders,
    engineDefault: settings.defaultModelId,
  };
}

/**
 * Mirrors the runtime's provider lookup (`provider/model`, provider case-insensitive).
 * A bare name resolves only through the runnable roster, where it must be unambiguous.
 */
function checkModel(requested: string, access: CesiumModelAccess): ModelCheck {
  if (access.runnable.includes(requested)) {
    return { modelId: requested };
  }
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash).trim().toLowerCase();
    return access.credentialedProviders.has(provider)
      ? { modelId: requested }
      : { reason: `no API key is configured there for provider "${provider}"` };
  }
  const matches = access.runnable.filter((id) => id.slice(id.indexOf("/") + 1) === requested);
  if (matches.length === 1) {
    return { modelId: matches[0]! };
  }
  return matches.length > 1
    ? { reason: `"${requested}" matches several models (${matches.join(", ")}); use a full provider/model id` }
    : { reason: `no model with credentials there is named "${requested}"` };
}

function runnableList(access: CesiumModelAccess, engineLabel: string): string {
  if (access.runnable.length === 0) {
    return `No Cesium Agent model has credentials on ${engineLabel}.`;
  }
  const shown = access.runnable.slice(0, LISTED_MODELS_MAX);
  const more = access.runnable.length - shown.length;
  return `Models with credentials on ${engineLabel}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

/**
 * Model for a new agent: the requested one, else `fallback` (the Project
 * default), else the harness default. When that model has no credentials on
 * the engine, the agent starts on the first runnable of the Project default,
 * the engine default or any credentialed model, and `warning` says why.
 */
export async function chooseChildModel(input: {
  harness: string;
  requested?: string | null;
  fallback?: string | null;
  engineLabel: string;
}): Promise<ChildModelChoice> {
  const requested = input.requested?.trim() || null;
  const fallback = input.fallback?.trim() || null;
  if (input.harness !== CESIUM_HARNESS_ID) {
    return { modelId: requested ?? fallback, warning: null };
  }
  const access = await loadCesiumModelAccess();
  const engine = input.engineLabel;
  const wanted = requested ?? fallback ?? access.engineDefault;
  const check = checkModel(wanted, access);
  if ("modelId" in check) {
    return { modelId: requested || fallback ? check.modelId : null, warning: null };
  }
  const subject = requested
    ? `Model "${wanted}"`
    : fallback
      ? `The Project default model "${wanted}"`
      : `The ${engine} default model "${wanted}"`;
  const candidates: Array<[string | null, string]> = [
    [requested ? fallback : null, "the Project default"],
    [access.engineDefault, `the ${engine} default`],
    [access.runnable[0] ?? null, `the first model with credentials on ${engine}`],
  ];
  for (const [candidate, label] of candidates) {
    if (!candidate || candidate === wanted) {
      continue;
    }
    const replacement = checkModel(candidate, access);
    if ("modelId" in replacement) {
      return {
        modelId: replacement.modelId,
        warning: `${subject} cannot run on ${engine}: ${check.reason}. The agent runs on ${replacement.modelId} (${label}) instead. ${runnableList(access, engine)}`,
      };
    }
  }
  throw new ProjectError(
    `${subject} cannot run on ${engine}: ${check.reason}, and no other Cesium Agent model has credentials there. Add a provider key under Settings → Agents → Cesium Agent on ${engine}, or use another harness.`,
    400,
    "model_unavailable"
  );
}

/** Model change for an existing agent: resolved when runnable, otherwise refused. */
export async function requireRunnableChildModel(input: {
  harness: string;
  requested: string;
  engineLabel: string;
}): Promise<string> {
  const requested = input.requested.trim();
  if (input.harness !== CESIUM_HARNESS_ID) {
    return requested;
  }
  const access = await loadCesiumModelAccess();
  const check = checkModel(requested, access);
  if ("modelId" in check) {
    return check.modelId;
  }
  throw new ProjectError(
    `Model "${requested}" cannot run on ${input.engineLabel}: ${check.reason}. ${runnableList(access, input.engineLabel)}`,
    400,
    "model_unavailable"
  );
}
