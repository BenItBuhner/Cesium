"use client";

export const AGENT_BACKENDS_CHANGED_EVENT = "opencursor:agent-backends-changed";

export function notifyAgentBackendsChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(AGENT_BACKENDS_CHANGED_EVENT));
}
