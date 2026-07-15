"use client";

import type { AgentConversationStatus } from "@/lib/agent-types";
import type { BurnProgressStatus } from "@/lib/agent-chat";
import { isGoalMode } from "@/lib/chat-modes";

type TaskbarGoalProgressMode = "normal" | "paused" | "error" | "indeterminate" | "none";

type TaskbarGoalProgressPayload =
  | { active: false; mode?: "none"; retainSource?: boolean }
  | {
      active: true;
      progressPercent: number;
      mode: Exclude<TaskbarGoalProgressMode, "none">;
    };

type CesiumDesktopTaskbarBridge = {
  setTaskbarGoalProgress?: (input: TaskbarGoalProgressPayload) => Promise<boolean> | boolean;
};

type CesiumDesktopTaskbarGlobal = Window & {
  cesiumDesktop?: CesiumDesktopTaskbarBridge;
};

type TaskbarGoalSource = {
  payload: TaskbarGoalProgressPayload;
  activatedAt: number;
};

const taskbarGoalSources = new Map<string, TaskbarGoalSource>();
const taskbarGoalSourceActivations = new Map<string, number>();
let lastTaskbarSignature: string | null = null;
let taskbarGoalActivationCounter = 0;

function desktopTaskbarBridge(): CesiumDesktopTaskbarBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as CesiumDesktopTaskbarGlobal).cesiumDesktop ?? null;
}

function sendTaskbarGoalProgress(payload: TaskbarGoalProgressPayload): void {
  const bridge = desktopTaskbarBridge();
  if (!bridge?.setTaskbarGoalProgress) {
    return;
  }
  void Promise.resolve(bridge.setTaskbarGoalProgress(payload)).catch(() => undefined);
}

function taskbarModeForConversationStatus(
  status: AgentConversationStatus | null | undefined
): Exclude<TaskbarGoalProgressMode, "none" | "indeterminate"> {
  if (status === "paused" || status === "pause_requested" || status === "pausing") {
    return "paused";
  }
  if (status === "failed" || status === "interrupted" || status === "cancelled") {
    return "error";
  }
  return "normal";
}

export function resolveDesktopTaskbarGoalProgress(input: {
  mode: string;
  burnProgress: BurnProgressStatus | null | undefined;
  conversationStatus: AgentConversationStatus | null | undefined;
}): TaskbarGoalProgressPayload {
  if (!isGoalMode(input.mode) || !input.burnProgress) {
    return { active: false, mode: "none" };
  }
  if (input.burnProgress.completedAt != null) {
    return { active: false, mode: "none", retainSource: true };
  }
  return {
    active: true,
    progressPercent: input.burnProgress.progressPercent,
    mode: taskbarModeForConversationStatus(input.conversationStatus),
  };
}

export function markDesktopTaskbarGoalProgressSourceOpen(sourceId: string): void {
  const activatedAt = ++taskbarGoalActivationCounter;
  taskbarGoalSourceActivations.set(sourceId, activatedAt);
  const current = taskbarGoalSources.get(sourceId);
  if (current) {
    taskbarGoalSources.set(sourceId, { ...current, activatedAt });
    applyDesktopTaskbarGoalProgress();
  }
}

export function publishDesktopTaskbarGoalProgress(
  sourceId: string,
  payload: TaskbarGoalProgressPayload
): void {
  if (!payload.active) {
    if (payload.retainSource) {
      const current = taskbarGoalSources.get(sourceId);
      taskbarGoalSources.set(sourceId, {
        payload,
        activatedAt:
          taskbarGoalSourceActivations.get(sourceId) ??
          current?.activatedAt ??
          ++taskbarGoalActivationCounter,
      });
      applyDesktopTaskbarGoalProgress();
      return;
    }
    taskbarGoalSources.delete(sourceId);
    applyDesktopTaskbarGoalProgress();
    return;
  }

  taskbarGoalSources.set(sourceId, {
    payload,
    activatedAt:
      taskbarGoalSourceActivations.get(sourceId) ??
      taskbarGoalSources.get(sourceId)?.activatedAt ??
      ++taskbarGoalActivationCounter,
  });
  applyDesktopTaskbarGoalProgress();
}

function applyDesktopTaskbarGoalProgress(): void {
  const latest = [...taskbarGoalSources.values()].sort(
    (a, b) => a.activatedAt - b.activatedAt
  ).at(-1)?.payload;
  if (!latest || !latest.active) {
    if (lastTaskbarSignature === "clear") {
      return;
    }
    lastTaskbarSignature = "clear";
    sendTaskbarGoalProgress({ active: false, mode: "none" });
    return;
  }

  const signature = `${latest.progressPercent}:${latest.mode}`;
  if (lastTaskbarSignature === signature) {
    return;
  }
  lastTaskbarSignature = signature;
  sendTaskbarGoalProgress(latest);
}

export function clearDesktopTaskbarGoalProgress(sourceId: string): void {
  publishDesktopTaskbarGoalProgress(sourceId, { active: false, mode: "none" });
}
