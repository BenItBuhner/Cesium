"use client";

import { Server } from "lucide-react";
import {
  PageIntro,
  rowButtonClass,
  useSettingsShellChrome,
} from "@/components/editor/settings-ui";

const SERVER_BOUND_PAGE_COPY: Record<string, { title: string; body: string }> = {
  voice: {
    title: "Voice",
    body: "Speech-to-text, spoken replies, and the voice orb run on a connected engine.",
  },
  agents: {
    title: "Agents",
    body: "Harness keys, models, usage, and tool permissions belong to a connected engine.",
  },
  models: {
    title: "Models",
    body: "Model catalogs and picker visibility are loaded from the connected engine.",
  },
  usage: {
    title: "Usage",
    body: "Token, request, and subscription meters come from harnesses on a connected engine.",
  },
  cloudAgents: {
    title: "Cloud Agents",
    body: "Cloud agent routing uses the connected engine's harness configuration.",
  },
  plugins: {
    title: "Integrations",
    body: "Plugins, MCP servers, and skills are installed on a connected engine.",
  },
  extensions: {
    title: "Extensions",
    body: "Editor extensions are managed through the connected engine.",
  },
  rulesSkills: {
    title: "Rules, Skills, Subagents",
    body: "Rules, skills, and subagents are stored on a connected engine.",
  },
  actions: {
    title: "Actions",
    body: "Quick actions are saved on the connected engine so they apply across chats.",
  },
  storage: {
    title: "Storage",
    body: "Storage driver and migrations are engine configuration.",
  },
  updates: {
    title: "Updates",
    body: "In-place updates apply to the connected engine, not this client.",
  },
};

export function SettingsServerRequiredState({
  navId,
  phase = "none",
}: {
  navId: string;
  phase?: "none" | "checking";
}) {
  const chrome = useSettingsShellChrome();
  const copy = SERVER_BOUND_PAGE_COPY[navId] ?? {
    title: "Server required",
    body: "This page reads configuration from a connected engine.",
  };
  const checking = phase === "checking";

  return (
    <>
      <PageIntro title={copy.title} />
      <div className="flex flex-col items-start gap-[14px] rounded-[var(--radius-card)] bg-[var(--bg-card)] px-[18px] py-[20px]">
        <span className="flex size-[36px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--accent-bg)] text-[var(--text-secondary)]">
          <Server className="size-[18px]" strokeWidth={1.5} aria-hidden />
        </span>
        <div className="max-w-[520px]">
          <p className="font-sans text-[14px] font-medium text-[var(--text-primary)]">
            {checking ? "Checking for a connected server" : "Connect a server to use this page"}
          </p>
          <p className="mt-[6px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {checking
              ? `${copy.body} This page stays closed until an engine responds.`
              : `${copy.body} Appearance, shortcuts, and other client preferences stay available without an engine.`}
          </p>
        </div>
        {!checking && chrome?.navigate ? (
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => chrome.navigate?.("servers")}
          >
            Open Servers
          </button>
        ) : null}
      </div>
    </>
  );
}
