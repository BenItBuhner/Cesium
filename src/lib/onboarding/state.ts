"use client";

import { clientKeyValueStore } from "@cesium/client";
import type { SetupStepId } from "./platform";

/**
 * Local onboarding progress. The cloud copy (Convex `onboarding` table) is
 * merged in additively, so a step completed on any device is completed on
 * every device.
 *
 * Progress is account-scoped once we know a user key (`clerk:*` / `device:*`).
 * Guest/local-only sessions keep the unscoped key so a later sign-in on the
 * same device can adopt that progress into the new account.
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

export function onboardingStorageKey(accountKey?: string | null): string {
  const trimmed = accountKey?.trim();
  return trimmed ? `${ONBOARDING_STORAGE_KEY}:${trimmed}` : ONBOARDING_STORAGE_KEY;
}

function parseOnboardingState(raw: string | null): OnboardingState {
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
}

export function readOnboardingState(accountKey?: string | null): OnboardingState {
  try {
    return parseOnboardingState(
      clientKeyValueStore().getItem(onboardingStorageKey(accountKey))
    );
  } catch {
    return EMPTY_STATE;
  }
}

export function writeOnboardingState(
  state: OnboardingState,
  accountKey?: string | null
): void {
  clientKeyValueStore().setItem(
    onboardingStorageKey(accountKey),
    JSON.stringify(state)
  );
}

/**
 * Bind guest/local progress to a newly signed-in account on this device.
 * Never overwrite an account that already has its own steps.
 */
export function adoptOnboardingForAccount(accountKey: string): OnboardingState {
  const scoped = readOnboardingState(accountKey);
  if (scoped.completedSteps.length > 0 || scoped.completedAt != null) {
    return scoped;
  }
  const guest = readOnboardingState(null);
  if (guest.completedSteps.length > 0 || guest.completedAt != null) {
    writeOnboardingState(guest, accountKey);
    return guest;
  }
  return scoped;
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

export function isOnboardingFinished(
  state: OnboardingState,
  requiredSteps: SetupStepId[]
): boolean {
  return requiredSteps.every((step) => state.completedSteps.includes(step));
}
