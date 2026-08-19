/**
 * Compatibility wrapper around the shared harness CLI auth runner for Grok Build.
 */
import {
  cancelHarnessCliLogin,
  getHarnessCliAuthState,
  parseHarnessDeviceAuthOutput,
  startHarnessCliLogin,
} from "./harness-cli-auth.js";
import { detectHarnessCli } from "./agents/harness-runtime.js";

export type GrokBuildLoginState = {
  status: "idle" | "pending" | "awaiting-confirmation" | "success" | "failed";
  verificationUrl?: string;
  userCode?: string;
  outputTail?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

export const parseGrokDeviceAuthOutput = parseHarnessDeviceAuthOutput;

function toGrokState(): GrokBuildLoginState {
  const state = getHarnessCliAuthState("grok-build");
  return {
    status: state.status,
    verificationUrl: state.verificationUrl,
    userCode: state.userCode,
    outputTail: state.outputTail,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

export function getGrokBuildLoginState(): GrokBuildLoginState {
  return toGrokState();
}

export function isGrokCliInstalled(): boolean {
  return detectHarnessCli("grok") != null;
}

export async function startGrokBuildDeviceLogin(): Promise<GrokBuildLoginState> {
  await startHarnessCliLogin("grok-build");
  return toGrokState();
}

export function cancelGrokBuildDeviceLogin(): GrokBuildLoginState {
  cancelHarnessCliLogin("grok-build");
  return toGrokState();
}
