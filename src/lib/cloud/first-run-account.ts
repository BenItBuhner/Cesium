"use client";

import { clientKeyValueStore } from "@cesium/client";
import type { CloudMode } from "./cloud-flags";

type CloudStatus = "disabled" | "signed-out" | "loading" | "ready";

/**
 * First-install cloud account prompt. Packaged clients (Android, iOS,
 * Electron) boot straight into the workbench - they never see the marketing
 * landing page - so a signed-out clerk-mode session must ask for sign-in /
 * sign-up before the empty local shell. "Continue as guest" is remembered
 * so returning users are not nagged.
 */
export const FIRST_RUN_ACCOUNT_STORAGE_KEY = "cesium-first-run-account";

export type FirstRunAccountChoice = "guest" | "signed-in";

export type FirstRunAccountState = {
  dismissedAt: number | null;
  choice: FirstRunAccountChoice | null;
};

const EMPTY_STATE: FirstRunAccountState = { dismissedAt: null, choice: null };

function isChoice(value: unknown): value is FirstRunAccountChoice {
  return value === "guest" || value === "signed-in";
}

export function readFirstRunAccountState(): FirstRunAccountState {
  try {
    const raw = clientKeyValueStore().getItem(FIRST_RUN_ACCOUNT_STORAGE_KEY);
    if (!raw) {
      return EMPTY_STATE;
    }
    const parsed = JSON.parse(raw) as Partial<FirstRunAccountState>;
    return {
      dismissedAt:
        typeof parsed.dismissedAt === "number" ? parsed.dismissedAt : null,
      choice: isChoice(parsed.choice) ? parsed.choice : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function writeFirstRunAccountState(state: FirstRunAccountState): void {
  clientKeyValueStore().setItem(
    FIRST_RUN_ACCOUNT_STORAGE_KEY,
    JSON.stringify(state)
  );
}

export function dismissFirstRunAccount(choice: FirstRunAccountChoice): void {
  writeFirstRunAccountState({ dismissedAt: Date.now(), choice });
}

export function isFirstRunAccountDismissed(
  state: FirstRunAccountState = readFirstRunAccountState()
): boolean {
  return state.dismissedAt != null || state.choice != null;
}

/**
 * Show the first-run account wall when this client is in Clerk mode, the
 * user has not already signed in or chosen guest, and Clerk is not still
 * resolving a returning session.
 */
export function shouldPromptFirstRunAccount(input: {
  cloudMode: CloudMode;
  cloudStatus: CloudStatus;
  dismissed: boolean;
}): boolean {
  if (input.dismissed) {
    return false;
  }
  if (input.cloudMode !== "clerk") {
    return false;
  }
  if (input.cloudStatus === "ready" || input.cloudStatus === "disabled") {
    return false;
  }
  return input.cloudStatus === "signed-out";
}
