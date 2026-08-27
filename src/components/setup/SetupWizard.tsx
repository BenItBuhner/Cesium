"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import {
  getActiveServerConnection,
  getConfiguredServerBaseUrl,
} from "@cesium/client";
import { adoptDeviceKey } from "@/lib/cloud/cloud-env";
import { useCloudContext } from "@/contexts/CloudContext";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";
import {
  getPlatformSetupProfile,
  SETUP_STEP_LABELS,
  type SetupStepId,
} from "@/lib/onboarding/platform";
import {
  markStepComplete,
  mergeOnboardingState,
  readOnboardingState,
  writeOnboardingState,
  type OnboardingState,
} from "@/lib/onboarding/state";
import { CloudAccountChip } from "./CloudAccountChip";
import { ConnectServerStep } from "./ConnectServerStep";
import { AgentsStep } from "./AgentsStep";
import { ImportStep } from "./ImportStep";
import { FirstChatStep } from "./FirstChatStep";

const STEP_DESCRIPTIONS: Record<SetupStepId, string> = {
  "connect-server":
    "Install or attach an engine. Production uses Clerk; a pasted URL cannot expose an open server.",
  agents:
    "Pick the coding agents you want. Missing CLIs install with one click.",
  import: "Bring conversations from other tools or from your cloud account.",
  "first-chat": "Pick a folder, pick an agent, say hello.",
};

/**
 * The barebones cross-platform setup flow. Steps come from the platform
 * profile (Electron drops the server step down to a footnote), progress is
 * mirrored to the user's cloud context so setup resumes on any device, and
 * every step is skippable - local-first means nothing here is a wall.
 */
export function SetupWizard() {
  const cloud = useCloudContext();
  const searchParams = useSearchParams();
  const profile = useMemo(() => getPlatformSetupProfile(), []);

  // Device-mode account linking: /setup?link=<deviceKey> adopts an existing
  // device identity - the keyless analogue of signing in on a new machine.
  useEffect(() => {
    const link = searchParams?.get("link");
    if (link && adoptDeviceKey(link)) {
      window.location.replace("/setup");
    }
  }, [searchParams]);
  const [state, setState] = useState<OnboardingState>(() => readOnboardingState());
  const [activeStep, setActiveStep] = useState<SetupStepId>(
    () =>
      profile.steps.find(
        (step) => !readOnboardingState().completedSteps.includes(step)
      ) ?? profile.steps[0]
  );
  const [engineBaseUrl, setEngineBaseUrl] = useState<string>(() =>
    profile.serverConnection === "footnote"
      ? getActiveServerConnection(getConfiguredServerBaseUrl()).baseUrl
      : getActiveServerConnection(getConfiguredServerBaseUrl()).baseUrl
  );
  const [engineName, setEngineName] = useState<string | null>(null);
  const [agentsReady, setAgentsReady] = useState(false);

  // Cloud onboarding progress merges in additively (resume on any device).
  useEffect(() => {
    if (!cloud.bootstrap?.onboarding) {
      return;
    }
    setState((current) => {
      const merged = mergeOnboardingState(current, cloud.bootstrap!.onboarding);
      if (merged.completedSteps.length !== current.completedSteps.length) {
        writeOnboardingState(merged);
        return merged;
      }
      return current;
    });
  }, [cloud.bootstrap]);

  const complete = useCallback(
    (step: SetupStepId, options?: { advance?: boolean }) => {
      setState((current) => {
        const next = markStepComplete(current, step);
        if (next !== current) {
          writeOnboardingState(next);
          if (cloud.actions) {
            void cloud.actions
              .updateOnboarding({
                platform: profile.platform,
                completeSteps: [step],
              })
              .catch(() => undefined);
          }
        }
        return next;
      });
      if (options?.advance !== false) {
        const index = profile.steps.indexOf(step);
        const nextStep = profile.steps[index + 1];
        if (nextStep) {
          setActiveStep(nextStep);
        }
      }
    },
    [cloud.actions, profile]
  );

  const allDone = profile.steps.every((step) =>
    state.completedSteps.includes(step)
  );

  useEffect(() => {
    if (!allDone || state.completedAt) {
      return;
    }
    const next = { ...state, completedAt: Date.now() };
    writeOnboardingState(next);
    setState(next);
    if (cloud.actions) {
      void cloud.actions
        .updateOnboarding({ platform: profile.platform, markComplete: true })
        .catch(() => undefined);
    }
  }, [allDone, state, cloud.actions, profile.platform]);

  const renderStep = (step: SetupStepId) => {
    switch (step) {
      case "connect-server":
        return (
          <ConnectServerStep
            onConnected={(baseUrl) => {
              setEngineBaseUrl(baseUrl);
              setEngineName(
                getActiveServerConnection(getConfiguredServerBaseUrl()).label
              );
              complete("connect-server");
            }}
          />
        );
      case "agents":
        return (
          <div className="space-y-[14px]">
            <AgentsStep baseUrl={engineBaseUrl} onReady={setAgentsReady} />
            <button
              type="button"
              disabled={!agentsReady}
              onClick={() => complete("agents")}
              className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[16px] py-[9px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
            >
              Continue
              <ArrowRight className="size-[14px]" strokeWidth={2} aria-hidden />
            </button>
          </div>
        );
      case "import":
        return (
          <div className="space-y-[14px]">
            <ImportStep
              baseUrl={engineBaseUrl}
              onImported={() => complete("import", { advance: false })}
            />
            <button
              type="button"
              onClick={() => complete("import")}
              className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[16px] py-[9px] text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
            >
              {state.completedSteps.includes("import") ? "Continue" : "Skip for now"}
              <ArrowRight className="size-[14px]" strokeWidth={2} aria-hidden />
            </button>
          </div>
        );
      case "first-chat":
        return (
          <FirstChatStep
            baseUrl={engineBaseUrl}
            serverName={engineName}
            onStarted={() => complete("first-chat", { advance: false })}
          />
        );
    }
  };

  return (
    <div className="fixed inset-0 z-0 overflow-y-auto bg-[var(--bg-main)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-main)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[56px] max-w-[860px] items-center justify-between px-[24px]">
          <div className="flex items-center gap-[10px]">
            <span className="text-[15px] font-semibold tracking-tight">
              Set up Cesium
            </span>
            <span className="rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[3px] font-mono text-[10.5px] text-[var(--text-disabled)]">
              {profile.platform}
            </span>
          </div>
          <CloudAccountChip />
        </div>
      </header>

      <main className="mx-auto max-w-[860px] px-[24px] py-[36px]">
        {allDone ? (
          <div className="mb-[24px] flex items-center justify-between rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[18px]">
            <div>
              <p className="text-[15px] font-semibold text-[var(--text-primary)]">
                You&apos;re all set.
              </p>
              <p className="text-[13px] text-[var(--text-secondary)]">
                {cloud.actions
                  ? "Everything is synced - sign in anywhere and pick up where you left off."
                  : "Setup saved on this device."}
              </p>
            </div>
            <Link
              href={WORKSPACE_ROUTE}
              className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[16px] py-[9px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
            >
              Open the workbench
              <ArrowRight className="size-[14px]" strokeWidth={2} aria-hidden />
            </Link>
          </div>
        ) : null}

        <ol className="space-y-[14px]">
          {profile.steps.map((step, index) => {
            const done = state.completedSteps.includes(step);
            const active = activeStep === step;
            return (
              <li
                key={step}
                className={`rounded-[var(--radius-card)] border ${
                  active
                    ? "border-[var(--border-card)] bg-[var(--bg-panel)]"
                    : "border-[var(--border-subtle)] bg-transparent"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveStep(step)}
                  className="flex w-full items-center gap-[12px] px-[18px] py-[14px] text-left"
                >
                  <span
                    className={`flex size-[26px] shrink-0 items-center justify-center rounded-full border font-mono text-[12px] ${
                      done
                        ? "border-transparent bg-[var(--ask-accent)] text-[var(--bg-main)]"
                        : active
                          ? "border-[var(--accent)] text-[var(--text-primary)]"
                          : "border-[var(--border-card)] text-[var(--text-disabled)]"
                    }`}
                  >
                    {done ? (
                      <Check className="size-[14px]" strokeWidth={2.5} aria-hidden />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span>
                    <span className="block text-[14.5px] font-semibold tracking-tight text-[var(--text-primary)]">
                      {SETUP_STEP_LABELS[step]}
                    </span>
                    <span className="block text-[12.5px] text-[var(--text-secondary)]">
                      {STEP_DESCRIPTIONS[step]}
                    </span>
                  </span>
                </button>
                {active ? (
                  <div className="border-t border-[var(--border-subtle)] px-[18px] py-[16px]">
                    {renderStep(step)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>

        {profile.serverConnection === "footnote" ? (
          <p className="mt-[20px] font-mono text-[11px] leading-relaxed text-[var(--text-disabled)]">
            Running on the desktop app - your local engine is already connected.
            Want to attach a remote machine too? Add it any time under{" "}
            <Link
              href={`${WORKSPACE_ROUTE}?view=settings`}
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-secondary)]"
            >
              Settings → Servers
            </Link>
            .
          </p>
        ) : null}
      </main>
    </div>
  );
}
