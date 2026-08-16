"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  PanelRight,
  Settings2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isQuickActionVisibleInContext,
  type AgentRailConversationSummary,
  type QuickActionDefinition,
  type QuickActionRunResult,
} from "@cesium/core";
import { quickActionPillIcon } from "@/components/chat/ComposerActionPills";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceInsights, requestWorkspaceInsightsRefresh } from "@/hooks/useWorkspaceInsights";
import type { NewChatWidgetId } from "@/lib/global-settings";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import { runQuickAction, useQuickActionsConfig } from "@/lib/quick-actions";
import { executeQuickActionUiCommand } from "@/lib/quick-action-ui";
import { isStandaloneChatWorkspace } from "@/lib/types";
import {
  getWorkspaceRailAppearance,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";
import { useAgentShellState } from "./AgentShellStateContext";

export const NEW_CHAT_WIDGET_LABELS: Record<NewChatWidgetId, string> = {
  shortcuts: "Shortcuts",
  actions: "Actions",
  "recent-chats": "Recent chats",
  "recent-activity": "Recent activity",
};

export const NEW_CHAT_WIDGET_DESCRIPTIONS: Record<NewChatWidgetId, string> = {
  shortcuts: "Plan-mode and editor-panel quick buttons.",
  actions:
    "Quick actions from Settings → Actions. Commands run in the selected workspace's path.",
  "recent-chats": "Jump back into your most recent conversations.",
  "recent-activity": "Recently opened workspaces, one click away.",
};

const MAX_ACTION_TILES = 8;
const MAX_RECENT_CHATS = 4;
const MAX_RECENT_WORKSPACES = 4;

/** Every widget tile shares one fill, outline, and corner radius. */
const TILE_CLASSNAME =
  "flex w-full min-w-0 items-center gap-[8px] rounded-[var(--radius-card)] border border-[var(--agent-border)] bg-[var(--agent-panel-bg)] px-[12px] py-[9px] text-left font-sans text-[12px] leading-none font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--agent-card-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60";
const TILE_ICON_CLASSNAME = "size-[13px] shrink-0 text-[var(--text-secondary)]";
const TILE_LABEL_CLASSNAME = "min-w-0 flex-1 truncate";
const TILE_META_CLASSNAME = "shrink-0 font-sans text-[10.5px] text-[var(--text-disabled)]";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "now";
}

function isRecentChatCandidate(summary: AgentRailConversationSummary): boolean {
  if (summary.archivedAt != null) {
    return false;
  }
  const busy =
    summary.status === "running" || summary.status === "awaiting_permission";
  if (summary.title === "New chat" && !busy) {
    return false;
  }
  return !summary.title.startsWith("Draft: ");
}

type ActionRunState =
  | { phase: "running" }
  | { phase: "confirm" }
  | { phase: "done"; result: QuickActionRunResult }
  | { phase: "error"; message: string; result?: QuickActionRunResult };

function ActionResultPopover({
  title,
  state,
  onClose,
}: {
  title: string;
  state: ActionRunState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  if (state.phase !== "done" && state.phase !== "error") {
    return null;
  }
  const result = state.phase === "done" ? state.result : state.result ?? null;
  const message = state.phase === "error" ? state.message : null;
  const outputTail = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.split(/\r?\n/).slice(-14).join("\n");
  };
  const stdout = outputTail(result?.stdout);
  const stderr = outputTail(result?.stderr);
  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+7px)] left-0 z-50 max-h-[320px] w-[min(420px,calc(100vw-24px))] overflow-auto rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px] shadow-[0_18px_50px_rgba(0,0,0,0.35)]"
    >
      <div className="mb-[8px] flex items-center justify-between gap-[10px]">
        <div className="font-sans text-[12px] font-semibold text-[var(--text-primary)]">
          {title}
        </div>
        <button
          type="button"
          className="rounded-[6px] px-[6px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="space-y-[8px]">
        {message ? (
          <div className="font-sans text-[11.5px] text-[var(--status-error)]">{message}</div>
        ) : null}
        {result?.kind === "command" && result.exitCode != null ? (
          <div className="font-sans text-[11px] text-[var(--text-secondary)]">
            Exit code {result.exitCode}
            {result.durationMs != null ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ""}
          </div>
        ) : null}
        {stdout ? (
          <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--bg-main)] p-[8px] font-mono text-[10.5px] leading-[15px] text-[var(--text-secondary)]">
            {stdout}
          </pre>
        ) : null}
        {stderr ? (
          <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-[var(--bg-main)] p-[8px] font-mono text-[10.5px] leading-[15px] text-[var(--status-error)]">
            {stderr}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Customizable tile grid rendered under the new-chat composer. Every tile
 * shares the same fill, outline, and corner radius — no widget titles.
 * Tiles come from four sources: quick shortcuts, quick actions (executed
 * against the actively selected workspace's path), recent conversations,
 * and recently opened workspaces. Order and visibility persist in
 * `settings.general.newChatWidgets` (Settings → General → New chat widgets,
 * or the gear popover on the landing).
 */
export function NewChatWidgets({ noWorkspaceDraft }: { noWorkspaceDraft: boolean }) {
  const { settings } = useGlobalSettings();
  const {
    activeWorkspaceId,
    workspaceInfo,
    workspaces,
    recentWorkspaceIds,
    homeWorkspaceId,
    openWorkspaceById,
    updateWorkspaceSession,
  } = useWorkspace();
  const {
    groups,
    pinnedRailConversations,
    openConversationSummary,
    setRightPaneOpen,
    setStandaloneDraftActive,
  } = useAgentShellState();
  const { activeServer } = useServerConnections();
  const { effectiveActions, loaded: actionsLoaded } = useQuickActionsConfig();
  const runCommand = useIDECommandRunner();

  const widgetsState = settings.general.newChatWidgets;
  const visibleWidgets = useMemo(
    () => widgetsState.order.filter((id) => !widgetsState.hidden.includes(id)),
    [widgetsState.hidden, widgetsState.order]
  );

  const actionsWidgetVisible =
    visibleWidgets.includes("actions") && !noWorkspaceDraft;

  const { insights } = useWorkspaceInsights({
    workspaceId: activeWorkspaceId,
    enabled: actionsWidgetVisible,
  });

  // ── Shortcuts ──────────────────────────────────────────────────────────────
  const planShortcutHint = useMemo(() => {
    return (
      getShortcutDisplayForCommand(
        settings.keyboardShortcuts.bindings,
        "workbench.action.focusChatPlanMode",
        detectShortcutPlatform()
      ) || "Mod+I"
    );
  }, [settings.keyboardShortcuts.bindings]);

  // ── Actions (quick actions run at the active workspace's root) ────────────
  const visibleActions = useMemo(() => {
    if (!actionsWidgetVisible || !actionsLoaded) {
      return [] as QuickActionDefinition[];
    }
    return effectiveActions
      .filter(
        (action) =>
          action.showPill &&
          isQuickActionVisibleInContext(action, {
            insights,
            conversationRunning: false,
            // The landing has no conversation yet; prompt actions are hidden.
            hasConversation: false,
          })
      )
      .slice(0, MAX_ACTION_TILES);
  }, [actionsLoaded, actionsWidgetVisible, effectiveActions, insights]);

  const [runStates, setRunStates] = useState<Record<string, ActionRunState>>({});
  const [openResultActionId, setOpenResultActionId] = useState<string | null>(null);
  const confirmTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setRunStates({});
    setOpenResultActionId(null);
  }, [activeWorkspaceId]);

  const setRunState = useCallback((actionId: string, state: ActionRunState | null) => {
    setRunStates((current) => {
      const next = { ...current };
      if (state == null) {
        delete next[actionId];
      } else {
        next[actionId] = state;
      }
      return next;
    });
  }, []);

  const openActionsSettings = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "actions" },
      layout: { ...current.layout, shellView: "settings", priorShellView: "agent" },
    }));
  }, [updateWorkspaceSession]);

  const executeAction = useCallback(
    async (action: QuickActionDefinition) => {
      if (action.kind === "ui") {
        executeQuickActionUiCommand(action.uiCommand ?? "", {
          runIdeCommand: runCommand,
          openActionsSettings,
          updateWorkspaceSession,
        });
        return;
      }
      setRunState(action.id, { phase: "running" });
      try {
        // Runs on the server against the actively selected workspace: the
        // request carries the active workspace id, and command actions spawn
        // at that workspace's root path.
        const response = await runQuickAction(action.id);
        const result = response.result;
        if (result.ok) {
          setRunState(action.id, { phase: "done", result });
          if (result.kind === "command" && (result.stdout?.trim() || result.stderr?.trim())) {
            setOpenResultActionId(action.id);
          }
          window.setTimeout(() => {
            setRunState(action.id, null);
            setOpenResultActionId((current) => (current === action.id ? null : current));
          }, 6000);
        } else {
          setRunState(action.id, {
            phase: "error",
            message: result.error ?? "Action failed.",
            result,
          });
          setOpenResultActionId(action.id);
        }
      } catch (error) {
        setRunState(action.id, {
          phase: "error",
          message: error instanceof Error ? error.message : "Action failed.",
        });
        setOpenResultActionId(action.id);
      } finally {
        requestWorkspaceInsightsRefresh();
      }
    },
    [openActionsSettings, runCommand, setRunState, updateWorkspaceSession]
  );

  const handleActionClick = useCallback(
    (action: QuickActionDefinition) => {
      const current = runStates[action.id];
      if (current?.phase === "running") {
        return;
      }
      if (current?.phase === "error" || current?.phase === "done") {
        setOpenResultActionId((open) => (open === action.id ? null : action.id));
        return;
      }
      if (action.confirm && current?.phase !== "confirm") {
        setRunState(action.id, { phase: "confirm" });
        confirmTimersRef.current[action.id] = window.setTimeout(() => {
          setRunState(action.id, null);
        }, 5000);
        return;
      }
      if (current?.phase === "confirm") {
        window.clearTimeout(confirmTimersRef.current[action.id]);
        delete confirmTimersRef.current[action.id];
      }
      void executeAction(action);
    },
    [executeAction, runStates, setRunState]
  );

  // ── Recent chats ───────────────────────────────────────────────────────────
  const recentChats = useMemo(() => {
    const seen = new Set<string>();
    const summaries: AgentRailConversationSummary[] = [];
    const push = (summary: AgentRailConversationSummary) => {
      if (seen.has(summary.id) || !isRecentChatCandidate(summary)) {
        return;
      }
      seen.add(summary.id);
      summaries.push(summary);
    };
    for (const summary of pinnedRailConversations) {
      push(summary);
    }
    for (const group of groups) {
      for (const summary of group.conversations) {
        push(summary);
      }
    }
    return summaries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_CHATS);
  }, [groups, pinnedRailConversations]);

  const workspaceNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of groups) {
      if (!names.has(group.workspace.id)) {
        names.set(group.workspace.id, group.workspace.name);
      }
    }
    for (const workspace of workspaces) {
      if (!names.has(workspace.id)) {
        names.set(workspace.id, workspace.name);
      }
    }
    return names;
  }, [groups, workspaces]);

  // ── Recent activity (recently opened workspaces) ──────────────────────────
  const recentWorkspaces = useMemo(() => {
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return recentWorkspaceIds
      .filter((id) => id !== activeWorkspaceId)
      .map((id) => byId.get(id))
      .filter(
        (workspace): workspace is NonNullable<typeof workspace> =>
          workspace != null && !isStandaloneChatWorkspace(workspace)
      )
      .slice(0, MAX_RECENT_WORKSPACES);
  }, [activeWorkspaceId, recentWorkspaceIds, workspaces]);

  // ── Customize popover ──────────────────────────────────────────────────────
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const customizePopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!customizeOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        setCustomizeOpen(false);
        return;
      }
      if (customizeButtonRef.current?.contains(target)) return;
      if (customizePopoverRef.current?.contains(target)) return;
      setCustomizeOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCustomizeOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [customizeOpen]);

  const toggleWidgetHidden = useNewChatWidgetVisibilityToggle();
  const moveWidget = useNewChatWidgetMove();

  // ── Tile renderers (uniform look, no titles) ───────────────────────────────
  const shortcutTiles: ReactNode[] = [
    <button
      key="shortcut-plan"
      type="button"
      onClick={() => runCommand?.("workbench.action.focusChatPlanMode")}
      className={TILE_CLASSNAME}
      title={`Start planning a new idea (${planShortcutHint})`}
    >
      <Lightbulb className={TILE_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
      <span className={TILE_LABEL_CLASSNAME}>Plan new idea</span>
      <span className={TILE_META_CLASSNAME}>{planShortcutHint}</span>
    </button>,
    <button
      key="shortcut-editor"
      type="button"
      onClick={() => setRightPaneOpen(true)}
      className={TILE_CLASSNAME}
      title="Open the editor panel"
    >
      <PanelRight className={TILE_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
      <span className={TILE_LABEL_CLASSNAME}>Open editor panel</span>
    </button>,
  ];

  const actionTiles: ReactNode[] = visibleActions.map((action) => {
    const Icon = quickActionPillIcon(action.icon);
    const runState = runStates[action.id];
    const isRunning = runState?.phase === "running";
    const isConfirm = runState?.phase === "confirm";
    const isError = runState?.phase === "error";
    const isDone = runState?.phase === "done";
    const runsIn = workspaceInfo?.root ? ` — runs in ${workspaceInfo.root}` : "";
    return (
      <div key={`action-${action.id}`} className="relative min-w-0">
        <button
          type="button"
          onClick={() => handleActionClick(action)}
          disabled={isRunning}
          className={`${TILE_CLASSNAME} ${
            isError
              ? "!border-[color-mix(in_srgb,var(--status-error)_45%,transparent)]"
              : isConfirm
                ? "!border-[color-mix(in_srgb,var(--accent)_45%,transparent)]"
                : ""
          }`}
          title={
            action.kind === "command"
              ? `${action.command ?? action.label}${runsIn}`
              : action.label
          }
        >
          {isRunning ? (
            <LoaderCircle
              className="size-[13px] shrink-0 animate-spin text-[var(--accent)]"
              strokeWidth={2}
              aria-hidden
            />
          ) : isDone ? (
            <Check
              className="size-[13px] shrink-0 text-[var(--status-success,#4ade80)]"
              strokeWidth={2.2}
              aria-hidden
            />
          ) : isError ? (
            <X
              className="size-[13px] shrink-0 text-[var(--status-error)]"
              strokeWidth={2.2}
              aria-hidden
            />
          ) : (
            <Icon className={TILE_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
          )}
          <span className={TILE_LABEL_CLASSNAME}>
            {isConfirm ? `Run ${action.label}?` : action.label}
          </span>
        </button>
        {openResultActionId === action.id && runState ? (
          <ActionResultPopover
            title={action.label}
            state={runState}
            onClose={() => setOpenResultActionId(null)}
          />
        ) : null}
      </div>
    );
  });

  const recentChatTiles: ReactNode[] = recentChats.map((summary) => {
    const workspaceName = workspaceNameById.get(summary.workspaceId);
    const otherWorkspace =
      workspaceName != null && summary.workspaceId !== activeWorkspaceId
        ? workspaceName
        : null;
    return (
      <button
        key={`chat-${summary.id}`}
        type="button"
        onClick={() => void openConversationSummary(summary).catch(() => undefined)}
        className={TILE_CLASSNAME}
        title={otherWorkspace ? `${summary.title} — ${otherWorkspace}` : summary.title}
      >
        <MessageSquare className={TILE_ICON_CLASSNAME} strokeWidth={1.5} aria-hidden />
        <span className={TILE_LABEL_CLASSNAME}>{summary.title}</span>
        <span className={TILE_META_CLASSNAME}>{formatRelativeTime(summary.updatedAt)}</span>
      </button>
    );
  });

  const recentWorkspaceTiles: ReactNode[] = recentWorkspaces.map((workspace) => {
    const appearance = getWorkspaceRailAppearance(
      settings.general.workspaceRailAppearances,
      `${activeServer.id}:${workspace.id}`,
      { isHome: workspace.id === homeWorkspaceId }
    );
    return (
      <button
        key={`workspace-${workspace.id}`}
        type="button"
        onClick={() => {
          setStandaloneDraftActive(false);
          void openWorkspaceById(workspace.id).catch(() => undefined);
        }}
        className={TILE_CLASSNAME}
        title={workspace.root}
      >
        <WorkspaceFolderIcon
          iconName={appearance.icon}
          color={appearance.color}
          className="size-[13px] shrink-0"
          strokeWidth={1.5}
        />
        <span className={TILE_LABEL_CLASSNAME}>{workspace.name}</span>
        {workspace.lastOpenedAt ? (
          <span className={TILE_META_CLASSNAME}>
            {formatRelativeTime(workspace.lastOpenedAt)}
          </span>
        ) : null}
      </button>
    );
  });

  const tiles: ReactNode[] = visibleWidgets.flatMap((id) => {
    switch (id) {
      case "shortcuts":
        return shortcutTiles;
      case "actions":
        return actionTiles;
      case "recent-chats":
        return recentChatTiles;
      case "recent-activity":
        return recentWorkspaceTiles;
      default:
        return [];
    }
  });

  return (
    <div className="mt-[10px] flex w-full min-w-0 items-start gap-[6px]">
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-[8px] @min-[480px]:grid-cols-2 @min-[760px]:grid-cols-3">
        {tiles}
      </div>
      <div className="relative shrink-0">
        <button
          ref={customizeButtonRef}
          type="button"
          aria-label="Customize new chat widgets"
          title="Customize new chat widgets"
          onClick={() => setCustomizeOpen((open) => !open)}
          className={`flex size-[26px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-disabled)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] ${
            customizeOpen ? "bg-[var(--accent-bg)] text-[var(--text-primary)]" : ""
          }`}
        >
          <Settings2 className="size-[13px]" strokeWidth={1.5} aria-hidden />
        </button>
        {customizeOpen ? (
          <div
            ref={customizePopoverRef}
            className="absolute right-0 top-[calc(100%+6px)] z-[10002] w-[212px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[4px] shadow-lg"
            data-ide-input-sink
            onPointerDown={(event) => event.stopPropagation()}
          >
            {widgetsState.order.map((id, index) => {
              const hidden = widgetsState.hidden.includes(id);
              return (
                <div
                  key={id}
                  className="flex items-center gap-[4px] rounded-[var(--radius-tab)] px-[8px] py-[4px] font-sans text-[12px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
                >
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      hidden ? "text-[var(--text-disabled)]" : ""
                    }`}
                  >
                    {NEW_CHAT_WIDGET_LABELS[id]}
                  </span>
                  <button
                    type="button"
                    aria-label={`Move ${NEW_CHAT_WIDGET_LABELS[id]} up`}
                    disabled={index === 0}
                    onClick={() => moveWidget(id, -1)}
                    className="flex size-[20px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    <ChevronUp className="size-[12px]" strokeWidth={1.8} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${NEW_CHAT_WIDGET_LABELS[id]} down`}
                    disabled={index === widgetsState.order.length - 1}
                    onClick={() => moveWidget(id, 1)}
                    className="flex size-[20px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    <ChevronDown className="size-[12px]" strokeWidth={1.8} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`${hidden ? "Show" : "Hide"} ${NEW_CHAT_WIDGET_LABELS[id]}`}
                    onClick={() => toggleWidgetHidden(id)}
                    className="flex size-[20px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                  >
                    {hidden ? (
                      <EyeOff className="size-[12px]" strokeWidth={1.8} aria-hidden />
                    ) : (
                      <Eye className="size-[12px]" strokeWidth={1.8} aria-hidden />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Toggle a widget in/out of `settings.general.newChatWidgets.hidden`.
 * Shared by the landing gear popover and Settings → General.
 */
export function useNewChatWidgetVisibilityToggle(): (id: NewChatWidgetId) => void {
  const { updateSettings } = useGlobalSettings();
  return useCallback(
    (id: NewChatWidgetId) => {
      updateSettings((current) => {
        const hidden = current.general.newChatWidgets.hidden;
        return {
          ...current,
          general: {
            ...current.general,
            newChatWidgets: {
              ...current.general.newChatWidgets,
              hidden: hidden.includes(id)
                ? hidden.filter((value) => value !== id)
                : [...hidden, id],
            },
          },
        };
      });
    },
    [updateSettings]
  );
}

/**
 * Move a widget within `settings.general.newChatWidgets.order`.
 * Shared by the landing gear popover and Settings → General.
 */
export function useNewChatWidgetMove(): (id: NewChatWidgetId, delta: -1 | 1) => void {
  const { updateSettings } = useGlobalSettings();
  return useCallback(
    (id: NewChatWidgetId, delta: -1 | 1) => {
      updateSettings((current) => {
        const order = [...current.general.newChatWidgets.order];
        const index = order.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= order.length) {
          return current;
        }
        [order[index], order[target]] = [order[target]!, order[index]!];
        return {
          ...current,
          general: {
            ...current.general,
            newChatWidgets: { ...current.general.newChatWidgets, order },
          },
        };
      });
    },
    [updateSettings]
  );
}
