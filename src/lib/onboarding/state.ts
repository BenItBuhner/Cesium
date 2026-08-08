"use client";

import { clientKeyValueStore } from "@cesium/client";
import type { SetupStepId } from "./platform";

/**
 * Local onboarding progress. The cloud copy (Convex `onboarding` table) is
 * merged in additively, so a step completed on any device is completed on
 * every device.
 */

export const ONBOARDING_STORAGE_KEY = "cesium-onboarding";

export type OnboardingState = {
  completedSteps: SetupStepId[];
  completedAt: number | null;
};

const EMPTY_STATE: OnboardingState = { completedSteps: [], completedAt: null };

const VALID_STEPS = new Set<SetupStepId>([
  "connect-server",
  "agents",
  "import",
  "first-chat",
]);

export function readOnboardingState(): OnboardingState {
  try {
    const raw = clientKeyValueStore().getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) {
      return EMPTY_STATE;
    }
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      completedSteps: Array.isArray(parsed.completedSteps)
        ? parsed.completedSteps.filter((step): step is SetupStepId =>
            VALID_STEPS.has(step as SetupStepId)
          )
        : [],
      completedAt:
        typeof parsed.completedAt === "number" ? parsed.completedAt : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function writeOnboardingState(state: OnboardingState): void {
  clientKeyValueStore().setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

export function mergeOnboardingState(
  local: OnboardingState,
  cloud: { completedSteps: string[]; completedAt: number | null } | null
): OnboardingState {
  if (!cloud) {
    return local;
  }
  const steps = new Set<SetupStepId>(local.completedSteps);
  for (const step of cloud.completedSteps) {
    if (VALID_STEPS.has(step as SetupStepId)) {
      steps.add(step as SetupStepId);
    }
  }
  return {
    completedSteps: [...steps],
    completedAt: local.completedAt ?? cloud.completedAt,
  };
}

export function markStepComplete(
  state: OnboardingState,
  step: SetupStepId
): OnboardingState {
  if (state.completedSteps.includes(step)) {
    return state;
  }
  return { ...state, completedSteps: [...state.completedSteps, step] };
}
