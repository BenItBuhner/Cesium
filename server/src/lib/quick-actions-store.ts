import path from "node:path";
import {
  createDefaultQuickActionsConfig,
  normalizeQuickActionDefinition,
  normalizeQuickActionsConfig,
  getQuickActionPreset,
  type QuickActionDefinition,
  type QuickActionsConfig,
} from "@cesium/core/quick-actions";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./persistence.js";

function quickActionsFilePath(): string {
  return path.join(DATA_DIR, "profile", "quick-actions.json");
}

/**
 * Read-modify-write cycles over the config file are serialized through one
 * in-process chain so concurrent settings edits cannot drop each other.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.catch(() => undefined).then(fn);
  mutationChain = run.catch(() => undefined);
  return run;
}

export async function getQuickActionsConfig(): Promise<QuickActionsConfig> {
  const raw = await readJsonFile<unknown>(quickActionsFilePath(), null);
  if (raw == null) {
    return createDefaultQuickActionsConfig();
  }
  return normalizeQuickActionsConfig(raw);
}

async function saveQuickActionsConfig(config: QuickActionsConfig): Promise<void> {
  await writeJsonFile(quickActionsFilePath(), config);
}

export async function upsertCustomQuickAction(
  raw: unknown
): Promise<QuickActionDefinition> {
  return enqueueMutation(async () => {
    const normalized = normalizeQuickActionDefinition(raw);
    if (!normalized) {
      throw new Error(
        "Invalid quick action: requires id, label, kind, and the matching payload field (command / prompt / uiCommand)."
      );
    }
    if (normalized.id.startsWith("preset:")) {
      throw new Error("Custom action ids cannot use the reserved preset: prefix.");
    }
    const config = await getQuickActionsConfig();
    const existing = config.customActions.find((action) => action.id === normalized.id);
    const next: QuickActionDefinition = {
      ...normalized,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    const customActions = [
      ...config.customActions.filter((action) => action.id !== normalized.id),
      next,
    ];
    await saveQuickActionsConfig({ ...config, customActions });
    return next;
  });
}

export async function removeCustomQuickAction(actionId: string): Promise<boolean> {
  return enqueueMutation(async () => {
    const config = await getQuickActionsConfig();
    const customActions = config.customActions.filter((action) => action.id !== actionId);
    if (customActions.length === config.customActions.length) {
      return false;
    }
    await saveQuickActionsConfig({ ...config, customActions });
    return true;
  });
}

export async function setQuickActionPresetStates(
  states: Record<string, unknown>
): Promise<QuickActionsConfig> {
  return enqueueMutation(async () => {
    const config = await getQuickActionsConfig();
    const presetStates = { ...config.presetStates };
    for (const [presetId, value] of Object.entries(states)) {
      if (typeof value !== "boolean" || !getQuickActionPreset(presetId)) {
        continue;
      }
      presetStates[presetId] = value;
    }
    const next = { ...config, presetStates };
    await saveQuickActionsConfig(next);
    return next;
  });
}
