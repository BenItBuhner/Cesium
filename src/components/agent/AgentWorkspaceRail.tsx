"use client";

import { useMemo, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { SidebarAppMenu } from "@/components/sidebar/SidebarAppMenu";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import type { ChatTab, WorkspaceRecord } from "@/lib/types";

type WorkspacePreview = {
  chatTabs: ChatTab[];
  editorTabCount: number;
  terminalTabCount: number;
  browserTabCount: number;
  activeChatTitle: string | null;
};

function deriveWorkspacePreview(
  session: WorkspaceSessionState | null | undefined
): WorkspacePreview {
  const chatTabs = Array.isArray(session?.chat?.tabs) ? session.chat.tabs : [];
  const leftTabs = Array.isArray(session?.editor?.leftTabs) ? session.editor.leftTabs : [];
  const rightTabs = Array.isArray(session?.editor?.rightTabs) ? session.editor.rightTabs : [];
  const editorTabs = [...leftTabs, ...rightTabs];
  return {
    chatTabs,
    editorTabCount: editorTabs.length,
    terminalTabCount: editorTabs.filter((tab) => Boolean(tab.terminalId)).length,
    browserTabCount: editorTabs.filter((tab) => Boolean(tab.browser)).length,
    activeChatTitle:
      chatTabs.find((tab) => tab.active)?.title ??
      chatTabs[0]?.title ??
      null,
  };
}

function sortWorkspaces(
  workspaces: WorkspaceRecord[],
  activeWorkspaceId: string | null,
  recentWorkspaceIds: string[]
): WorkspaceRecord[] {
  const recentOrder = new Map(recentWorkspaceIds.map((id, index) => [id, index]));
  return [...workspaces].sort((left, right) => {
    if (left.id === activeWorkspaceId) {
      return -1;
    }
    if (right.id === activeWorkspaceId) {
      return 1;
    }
    const leftRecent = recentOrder.get(left.id);
    const rightRecent = recentOrder.get(right.id);
    if (leftRecent != null && rightRecent != null) {
      return leftRecent - rightRecent;
    }
    if (leftRecent != null) {
      return -1;
    }
    if (rightRecent != null) {
      return 1;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function formatWorkspaceStats(preview: WorkspacePreview): string {
  const segments = [
    `${preview.chatTabs.length} chat${preview.chatTabs.length === 1 ? "" : "s"}`,
    `${preview.editorTabCount} tab${preview.editorTabCount === 1 ? "" : "s"}`,
  ];
  const toolCount = preview.terminalTabCount + preview.browserTabCount;
  if (toolCount > 0) {
    segments.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  }
  return segments.join(" · ");
}

export function AgentWorkspaceRail({
  activeWorkspaceId,
  defaultWorkspaceId,
  recentWorkspaceIds,
  workspaces,
  previewsByWorkspaceId,
  pendingWorkspaceId,
  onSelectWorkspace,
  onSelectWorkspaceChat,
}: {
  activeWorkspaceId: string | null;
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  workspaces: WorkspaceRecord[];
  previewsByWorkspaceId: Record<string, WorkspaceSessionState | null>;
  pendingWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectWorkspaceChat: (workspaceId: string, chatTabId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const orderedWorkspaces = useMemo(
    () => sortWorkspaces(workspaces, activeWorkspaceId, recentWorkspaceIds),
    [activeWorkspaceId, recentWorkspaceIds, workspaces]
  );

  const filteredWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return orderedWorkspaces;
    }
    return orderedWorkspaces.filter((workspace) =>
      `${workspace.name} ${workspace.root}`.toLowerCase().includes(normalizedQuery)
    );
  }, [orderedWorkspaces, query]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_88%,transparent)]">
      <div className="shrink-0 border-b border-[var(--border-card)] px-[14px] pb-[14px] pt-[12px]">
        <div className="flex items-center gap-[10px]">
          <SidebarAppMenu />
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
              Agent workspaces
            </div>
            <div className="font-sans text-[11px] text-[var(--text-secondary)]">
              Jump across saved chats and tools without losing state.
            </div>
          </div>
        </div>
        <div className="relative mt-[12px]">
          <Search
            className="pointer-events-none absolute left-[10px] top-1/2 size-[14px] -translate-y-1/2 text-[var(--text-secondary)]"
            strokeWidth={1.75}
          />
          <HardwareAwareTextInput
            value={query}
            onChange={setQuery}
            placeholder="Filter workspaces"
            ariaLabel="Filter workspaces"
            className="h-[34px] w-full rounded-[12px] border border-[var(--border-card)] bg-[var(--bg-main)] pl-[32px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          />
        </div>
      </div>

      <div className="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto px-[10px] pb-[10px] pt-[8px]">
        {filteredWorkspaces.length === 0 ? (
          <div className="rounded-[20px] border border-dashed border-[var(--border-card)] px-[14px] py-[16px] font-sans text-[12px] text-[var(--text-secondary)]">
            No workspaces match that filter.
          </div>
        ) : null}

        <div className="flex flex-col gap-[10px]">
          {filteredWorkspaces.map((workspace) => {
            const preview = deriveWorkspacePreview(previewsByWorkspaceId[workspace.id]);
            const chatPreview = preview.chatTabs.slice(0, 3);
            const extraChatCount = Math.max(preview.chatTabs.length - chatPreview.length, 0);
            const isActive = workspace.id === activeWorkspaceId;
            const isPending = workspace.id === pendingWorkspaceId;
            return (
              <section
                key={workspace.id}
                className={`rounded-[22px] border px-[12px] py-[12px] transition-colors ${
                  isActive
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent-bg)_75%,var(--bg-panel))]"
                    : "border-[var(--border-card)] bg-[var(--bg-panel)]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectWorkspace(workspace.id)}
                  className="flex w-full items-start gap-[10px] text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-[8px]">
                      <span className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                        {workspace.name}
                      </span>
                      {isActive ? (
                        <span className="rounded-full bg-[var(--accent-dark)] px-[7px] py-[2px] font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--bg-main)]">
                          Active
                        </span>
                      ) : null}
                      {workspace.id === defaultWorkspaceId ? (
                        <span className="rounded-full border border-[var(--border-card)] px-[7px] py-[2px] font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                          Default
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-[3px] truncate font-mono text-[11px] text-[var(--text-secondary)]">
                      {workspace.root}
                    </div>
                    <div className="mt-[8px] font-sans text-[11px] text-[var(--text-secondary)]">
                      {formatWorkspaceStats(preview)}
                    </div>
                    <div className="mt-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
                      {preview.activeChatTitle
                        ? `Resume: ${preview.activeChatTitle}`
                        : "Start a fresh chat from this workspace."}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-[6px]">
                    {recentWorkspaceIds.includes(workspace.id) ? (
                      <span className="rounded-full border border-[var(--border-card)] px-[7px] py-[2px] font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                        Recent
                      </span>
                    ) : null}
                    {isPending ? (
                      <LoaderCircle
                        className="size-[16px] animate-spin text-[var(--text-secondary)]"
                        strokeWidth={1.75}
                      />
                    ) : null}
                  </div>
                </button>

                <div className="mt-[10px] flex flex-wrap gap-[6px]">
                  {chatPreview.length > 0 ? (
                    chatPreview.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => onSelectWorkspaceChat(workspace.id, tab.id)}
                        className={`max-w-full rounded-full border px-[10px] py-[5px] font-sans text-[11px] transition-colors ${
                          isActive && tab.active
                            ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                            : "border-[var(--border-card)] bg-[var(--bg-main)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span className="block max-w-[180px] truncate">{tab.title}</span>
                      </button>
                    ))
                  ) : (
                    <span className="rounded-full border border-dashed border-[var(--border-card)] px-[10px] py-[5px] font-sans text-[11px] text-[var(--text-secondary)]">
                      No saved chats yet
                    </span>
                  )}
                  {extraChatCount > 0 ? (
                    <span className="rounded-full border border-[var(--border-card)] px-[10px] py-[5px] font-sans text-[11px] text-[var(--text-secondary)]">
                      +{extraChatCount} more
                    </span>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
