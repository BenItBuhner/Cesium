"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import {
  AGENT_LEFT_RAIL_EXPANDED_WIDTH,
  AGENT_SHELL_CENTER_MIN_PERCENT,
  AGENT_SHELL_DEFAULT_LAYOUT,
  AGENT_SHELL_PANEL_IDS,
  AGENT_SHELL_RAIL_MAX_PERCENT,
  AGENT_SHELL_RAIL_MIN_PERCENT,
  collapseAgentShellSideLayout,
  composeAgentShellDesktopLayout,
  normalizeAgentShellDesktopLayout,
  readAgentShellSharedSnapshot,
  writeAgentShellSharedSnapshot,
} from "@/components/agent/agent-shell-layout";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookMarked,
  Bot,
  Box,
  ChevronDown,
  CircleUserRound,
  Database,
  Download,
  ExternalLink,
  FlaskConical,
  Keyboard,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  Server,
  Settings,
} from "lucide-react";
import { ServerPickerPopover } from "@/components/preferences/ServerPickerPopover";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { SETTINGS_PANELS } from "@/components/editor/settings-panels";
import { DefaultServerSettingsBanner } from "@/components/preferences/DefaultServerSettingsBanner";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useViewport } from "@/hooks/useViewport";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import {
  getLastWorkspaceForServer,
  rememberLastWorkspaceForServer,
} from "@/lib/per-server-workspace-memory";
import { detectShortcutPlatform, primaryModifierLabel } from "@/lib/keyboard-shortcuts";
import { openDocumentation } from "@/lib/open-documentation";
import {
  buildSettingsSearchIndex,
  searchSettingsIndex,
  settingsSearchHitToFocus,
  type SettingsSearchEntry,
} from "@/lib/settings-search-index";

type NavEntry =
  | { kind: "item"; id: string; label: string; icon: LucideIcon }
  | { kind: "divider" };

/**
 * Settings categories we actually use in this shell (trimmed from full Cursor parity).
 */
const NAV_ENTRIES: NavEntry[] = [
  { kind: "item", id: "general", label: "General", icon: Settings },
  { kind: "item", id: "appearance", label: "Appearance", icon: Palette },
  { kind: "item", id: "keyboardShortcuts", label: "Keyboard shortcuts", icon: Keyboard },
  { kind: "item", id: "agents", label: "Agents", icon: Bot },
  { kind: "item", id: "models", label: "Models", icon: Box },
  { kind: "item", id: "plugins", label: "Plugins", icon: Puzzle },
  { kind: "divider" },
  { kind: "item", id: "servers", label: "Servers", icon: Server },
  { kind: "item", id: "rulesSkills", label: "Rules, Skills, Subagents", icon: BookMarked },
  { kind: "item", id: "exportImport", label: "Import & export", icon: Download },
  { kind: "item", id: "storage", label: "Storage", icon: Database },
  { kind: "item", id: "beta", label: "Beta", icon: FlaskConical },
];

const searchInputClass =
  "box-border h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const navItemClass =
  "flex h-[32px] w-full items-center gap-[10px] rounded-[var(--radius-tab)] px-[10px] text-left font-sans text-[13px] leading-none transition-colors";

const searchResultClass =
  "flex w-full flex-col gap-[2px] rounded-[var(--radius-tab)] px-[10px] py-[7px] text-left transition-colors hover:bg-[var(--accent-bg)]";

function searchResultKindLabel(kind: SettingsSearchEntry["kind"]): string {
  switch (kind) {
    case "model":
      return "Model";
    case "shortcut":
      return "Shortcut";
    case "harness":
      return "Harness";
    case "row":
      return "Setting";
    case "section":
      return "Section";
    default:
      return "Category";
  }
}

/**
 * Readable column on wide desktops (centered max width) while staying full-width when
 * the settings pane is narrow (e.g. dragged rail). Padding scales up on larger viewports.
 */
const SETTINGS_MAIN_CONTENT_SHELL_CLASS =
  "mx-auto w-full max-w-5xl px-7 sm:px-8 md:px-10 lg:px-12 xl:px-16";

function SettingsShellResizeHandle() {
  return (
    <Separator className="group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

export type SettingsEditorViewProps = {
  /** Full-screen settings shell: icon-only back control in the sidebar footer. */
  onCloseShell?: () => void;
};

function SettingsNavContent({
  activeNav,
  searchQuery,
  searchModLabel,
  searchResults,
  isSearching,
  selectedResultIndex,
  searchInputRef,
  onCloseShell,
  onNavChange,
  onSearchChange,
  onSearchKeyDown,
  onSelectSearchResult,
  onOpenDocs,
  closeMobileDrawer,
  isMobile,
  padSettingsSearchForWindowChrome,
}: {
  activeNav: string;
  searchQuery: string;
  searchModLabel: string;
  searchResults: SettingsSearchEntry[];
  isSearching: boolean;
  selectedResultIndex: number;
  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onCloseShell?: () => void;
  onNavChange: (id: string) => void;
  onSearchChange: (query: string) => void;
  onSearchKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => void;
  onSelectSearchResult: (hit: SettingsSearchEntry) => void;
  onOpenDocs: () => void;
  closeMobileDrawer?: () => void;
  isMobile: boolean;
  /** Windowed tab inset (beta): extra leading padding on the search field only (mobile drawer + desktop aside). */
  padSettingsSearchForWindowChrome: boolean;
}) {
  const { activeServer, servers, serverStatusById, setActiveServer } = useServerConnections();
  const { activeWorkspaceId, openWorkspaceById } = useWorkspace();
  const { byServerId: directoryByServerId } = useWorkspaceDirectory();
  const serverPickerAnchorRef = useRef<HTMLButtonElement>(null);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);

  const handleActiveServerChange = useCallback(
    (serverId: string) => {
      if (serverId === activeServer.id) {
        setServerPickerOpen(false);
        return;
      }
      if (activeWorkspaceId) {
        rememberLastWorkspaceForServer(activeServer.id, activeWorkspaceId);
      }
      setActiveServer(serverId);
      setServerPickerOpen(false);
      const restoredWorkspaceId = getLastWorkspaceForServer(serverId);
      const directoryWorkspaces = directoryByServerId.get(serverId) ?? [];
      const targetWorkspaceId =
        restoredWorkspaceId &&
        directoryWorkspaces.some((workspace) => workspace.id === restoredWorkspaceId)
          ? restoredWorkspaceId
          : directoryWorkspaces[0]?.id;
      if (targetWorkspaceId) {
        void openWorkspaceById(targetWorkspaceId).catch(() => undefined);
      }
    },
    [
      activeServer.id,
      activeWorkspaceId,
      directoryByServerId,
      openWorkspaceById,
      setActiveServer,
    ]
  );

  return (
    <div className="flex h-full flex-col bg-[var(--bg-panel)]">
      <div className="flex shrink-0 items-center gap-[8px] px-[11px] pt-[12px]">
        {isMobile ? (
          <button
            type="button"
            onClick={closeMobileDrawer}
            className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
            aria-label="Close settings nav"
            title="Close settings nav"
          >
            <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
          </button>
        ) : null}
        <div
          className={
            padSettingsSearchForWindowChrome
              ? `${isMobile ? "min-w-0 flex-1" : "min-w-0 flex-1"} pl-[var(--editor-window-chrome-tab-inset)]`
              : isMobile
                ? "min-w-0 flex-1"
                : "min-w-0 flex-1"
          }
        >
          <HardwareAwareTextInput
            inputRef={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={onSearchChange}
            onNativeKeyDown={onSearchKeyDown}
            placeholder={`Search settings ${searchModLabel}+F`}
            className={searchInputClass}
            ariaLabel="Search settings"
            ariaControls="settings-search-results"
            ariaExpanded={isSearching}
          />
        </div>
      </div>

      <nav
        className="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto px-[10px] pb-[8px] pt-[12px]"
        aria-label="Settings categories"
      >
        {isSearching ? (
          <div
            id="settings-search-results"
            role="listbox"
            aria-label="Settings search results"
            className="mb-[8px]"
          >
            {searchResults.length === 0 ? (
              <p className="px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
                No settings match &ldquo;{searchQuery.trim()}&rdquo;
              </p>
            ) : (
              searchResults.map((hit, index) => (
                <button
                  key={hit.id}
                  id={`settings-search-result-${hit.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === selectedResultIndex}
                  onClick={() => onSelectSearchResult(hit)}
                  className={`${searchResultClass} ${
                    index === selectedResultIndex
                      ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-[6px]">
                    <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--text-primary)]">
                      {hit.label}
                    </span>
                    <span className="shrink-0 font-sans text-[10px] uppercase tracking-wide text-[var(--text-disabled)]">
                      {searchResultKindLabel(hit.kind)}
                    </span>
                  </span>
                  <span className="truncate font-sans text-[11px] text-[var(--text-disabled)]">
                    {hit.subtitle}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            {NAV_ENTRIES.map((entry, i) => {
              if (entry.kind === "divider") {
                return (
                  <div
                    key={`d-${i}`}
                    className="my-[8px] h-px bg-[var(--border-subtle)]"
                    role="separator"
                  />
                );
              }
              const Icon = entry.icon;
              const sel = activeNav === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    onNavChange(entry.id);
                    if (isMobile && closeMobileDrawer) {
                      closeMobileDrawer();
                    }
                  }}
                  className={`${navItemClass} ${
                    sel
                      ? "bg-[var(--bg-panel)] font-medium text-[var(--text-primary)]"
                      : "font-normal text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Icon className="size-[16px] shrink-0" strokeWidth={1.5} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                </button>
              );
            })}
            <div className="my-[8px] h-px bg-[var(--border-subtle)]" role="separator" />
            <button
              type="button"
              onClick={onOpenDocs}
              className={`${navItemClass} font-normal text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]`}
              title="Open documentation in a new browser tab"
            >
              <ExternalLink className="size-[16px] shrink-0" strokeWidth={1.5} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">Docs</span>
            </button>
          </>
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-[8px] px-[11px] py-[10px]">
        <button
          ref={serverPickerAnchorRef}
          type="button"
          onClick={() => setServerPickerOpen((open) => !open)}
          className="flex min-w-0 flex-1 items-center gap-[8px] rounded-[var(--radius-tab)] py-[2px] text-left transition-colors hover:bg-[var(--bg-card)]"
          aria-label={`Switch server (${activeServer.label})`}
          aria-expanded={serverPickerOpen}
          aria-haspopup="menu"
          title={activeServer.label}
        >
          <CircleUserRound
            className="size-[18px] shrink-0 text-[var(--text-secondary)]"
            strokeWidth={1.5}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--text-primary)]">
            {activeServer.label}
          </span>
          <ChevronDown
            className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform ${
              serverPickerOpen ? "rotate-180" : ""
            }`}
            strokeWidth={1.5}
            aria-hidden
          />
        </button>
        {onCloseShell ? (
          <button
            type="button"
            onClick={onCloseShell}
            className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft className="size-[16px]" strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}
      </div>

      <ServerPickerPopover
        open={serverPickerOpen}
        onClose={() => setServerPickerOpen(false)}
        anchorRef={serverPickerAnchorRef}
        label="Switch server"
        selectedServerId={activeServer.id}
        servers={servers}
        serverStatusById={serverStatusById}
        onSelect={handleActiveServerChange}
        placement="above"
      />
    </div>
  );
}

export function SettingsEditorView({ onCloseShell }: SettingsEditorViewProps = {}) {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const { settings } = useGlobalSettings();
  const { experimentalIpadWindowedTabInset } = useUserPreferences();
  const { isMobile } = useViewport();
  const groupRef = useGroupRef();
  const applyingSettingsLayoutFromContextRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** iPad/tablet use width ≥768 (“desktop” settings layout); still need inset when window controls overlap the nav. */
  const padSettingsSearchForWindowChrome = experimentalIpadWindowedTabInset;
  const [activeNav, setActiveNav] = useState(workspaceSession.settingsView.activeNav);
  const [searchQuery, setSearchQuery] = useState(workspaceSession.settingsView.searchQuery);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 150);
  const scrollPersistTimerRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(workspaceSession.settingsView.scrollTop);
  const persistedScrollTopRef = useRef<number | null>(null);
  const resolvedNav = activeNav;
  const SettingsPanel = SETTINGS_PANELS[resolvedNav] ?? SETTINGS_PANELS.general;
  const searchModLabel = useMemo(
    () => primaryModifierLabel(detectShortcutPlatform()),
    []
  );

  const settingsSearchIndex = useMemo(
    () => buildSettingsSearchIndex(settings.models.byBackend ?? {}),
    [settings.models.byBackend]
  );

  const searchResults = useMemo(
    () => searchSettingsIndex(settingsSearchIndex, debouncedSearchQuery),
    [settingsSearchIndex, debouncedSearchQuery]
  );

  const isSearching = debouncedSearchQuery.trim().length > 0;

  useEffect(() => {
    setSelectedResultIndex(0);
  }, [debouncedSearchQuery]);

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (!focus || focus.kind !== "scroll" || focus.navId !== resolvedNav) {
      return;
    }
    const rowId = focus.rowId;
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }
    const timer = window.setTimeout(() => {
      const target = root.querySelector(`[data-settings-search-id="${rowId}"]`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          panelSearchFocus: null,
        },
      }));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [
    resolvedNav,
    updateWorkspaceSession,
    workspaceSession.settingsView.panelSearchFocus,
  ]);

  const sharedAgentShellLayout = useMemo(
    () => {
      const snapshotLayout = normalizeAgentShellDesktopLayout(
        readAgentShellSharedSnapshot()?.agentShellDesktopLayout
      );
      const workspaceLayout = normalizeAgentShellDesktopLayout(
        workspaceSession.agentView.agentShellDesktopLayout
      );
      return snapshotLayout ?? workspaceLayout ?? AGENT_SHELL_DEFAULT_LAYOUT;
    },
    [workspaceSession.agentView.agentShellDesktopLayout]
  );

  const settingsDesktopLayout = useMemo(() => {
    const collapsedLayout = collapseAgentShellSideLayout(sharedAgentShellLayout);
    return {
      [AGENT_SHELL_PANEL_IDS.rail]: collapsedLayout[AGENT_SHELL_PANEL_IDS.rail],
      [AGENT_SHELL_PANEL_IDS.center]: collapsedLayout[AGENT_SHELL_PANEL_IDS.center],
    };
  }, [sharedAgentShellLayout]);

  useLayoutEffect(() => {
    if (isMobile) {
      return;
    }
    applyingSettingsLayoutFromContextRef.current = true;
    try {
      groupRef.current?.setLayout(settingsDesktopLayout);
    } finally {
      queueMicrotask(() => {
        applyingSettingsLayoutFromContextRef.current = false;
      });
    }
  }, [groupRef, isMobile, settingsDesktopLayout]);

  const persistSettingsRailWidth = useCallback(
    (railPercent: number) => {
      const baseLayout =
        normalizeAgentShellDesktopLayout(
          readAgentShellSharedSnapshot()?.agentShellDesktopLayout
        ) ??
        normalizeAgentShellDesktopLayout(workspaceSession.agentView.agentShellDesktopLayout) ??
        AGENT_SHELL_DEFAULT_LAYOUT;
      const nextLayout =
        composeAgentShellDesktopLayout(
          {
            ...baseLayout,
            [AGENT_SHELL_PANEL_IDS.rail]: railPercent,
          },
          baseLayout
        ) ?? AGENT_SHELL_DEFAULT_LAYOUT;
      const previousSnapshot = readAgentShellSharedSnapshot();
      writeAgentShellSharedSnapshot({
        leftRailCollapsed: previousSnapshot?.leftRailCollapsed,
        agentShellDesktopLayout: nextLayout,
      });
      updateWorkspaceSession((current) => {
        const currentLayout =
          normalizeAgentShellDesktopLayout(current.agentView.agentShellDesktopLayout) ?? {};
        return {
          ...current,
          agentView: {
            ...current.agentView,
            agentShellDesktopLayout: {
              ...currentLayout,
              [AGENT_SHELL_PANEL_IDS.rail]: nextLayout[AGENT_SHELL_PANEL_IDS.rail],
            },
          },
        };
      });
    },
    [updateWorkspaceSession, workspaceSession.agentView.agentShellDesktopLayout]
  );

  useEffect(() => {
    const persistedNav = workspaceSession.settingsView.activeNav;
    if (persistedNav === "tools" || persistedNav === "mcps") {
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          activeNav: "plugins",
          mcpsOpen: true,
        },
      }));
      setActiveNav("plugins");
    } else {
      setActiveNav(persistedNav);
    }
    setSearchQuery(workspaceSession.settingsView.searchQuery);
  }, [
    updateWorkspaceSession,
    workspaceSession.settingsView.activeNav,
    workspaceSession.settingsView.searchQuery,
  ]);

  useEffect(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav,
        searchQuery,
      },
    }));
  }, [activeNav, searchQuery, updateWorkspaceSession]);

  const flushPersistedScrollTop = useCallback(() => {
    const nextScrollTop = pendingScrollTopRef.current;
    if (persistedScrollTopRef.current === nextScrollTop) {
      return;
    }
    persistedScrollTopRef.current = nextScrollTop;
    updateWorkspaceSession((current) =>
      Math.abs(current.settingsView.scrollTop - nextScrollTop) < 1
        ? current
        : {
            ...current,
            settingsView: {
              ...current.settingsView,
              scrollTop: nextScrollTop,
            },
          }
    );
  }, [updateWorkspaceSession]);

  const schedulePersistedScrollTop = useCallback(() => {
    if (scrollPersistTimerRef.current != null) {
      window.clearTimeout(scrollPersistTimerRef.current);
    }
    scrollPersistTimerRef.current = window.setTimeout(() => {
      scrollPersistTimerRef.current = null;
      flushPersistedScrollTop();
    }, 180);
  }, [flushPersistedScrollTop]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    if (
      persistedScrollTopRef.current != null &&
      Math.abs(persistedScrollTopRef.current - workspaceSession.settingsView.scrollTop) < 1
    ) {
      return;
    }
    root.scrollTop = workspaceSession.settingsView.scrollTop;
    pendingScrollTopRef.current = workspaceSession.settingsView.scrollTop;
    persistedScrollTopRef.current = workspaceSession.settingsView.scrollTop;
  }, [workspaceSession.settingsView.scrollTop]);

  const onMainScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const el = event.currentTarget ?? scrollRootRef.current;
      if (!el) {
        return;
      }
      pendingScrollTopRef.current = Math.round(el.scrollTop);
      schedulePersistedScrollTop();
    },
    [schedulePersistedScrollTop]
  );

  useEffect(() => {
    const flushOnPageHide = () => {
      flushPersistedScrollTop();
    };
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        flushPersistedScrollTop();
      }
    };
    window.addEventListener("pagehide", flushOnPageHide);
    window.addEventListener("beforeunload", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      window.removeEventListener("beforeunload", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnHidden);
      if (scrollPersistTimerRef.current != null) {
        window.clearTimeout(scrollPersistTimerRef.current);
        scrollPersistTimerRef.current = null;
      }
      flushPersistedScrollTop();
    };
  }, [flushPersistedScrollTop]);

  const closeMobileDrawer = useCallback(() => {
    setNavDrawerOpen(false);
  }, []);

  const handleNavChange = useCallback(
    (id: string) => {
      setActiveNav(id);
      if (id === "agents" && activeNav !== "agents") {
        updateWorkspaceSession((current) => ({
          ...current,
          settingsView: {
            ...current.settingsView,
            agentsHarnessId: null,
          },
        }));
      }
      if (id === "plugins" && activeNav !== "plugins") {
        updateWorkspaceSession((current) => ({
          ...current,
          settingsView: {
            ...current.settingsView,
            mcpsOpen: false,
          },
        }));
      }
      if (id !== "plugins") {
        updateWorkspaceSession((current) =>
          current.settingsView.mcpsOpen
            ? {
                ...current,
                settingsView: {
                  ...current.settingsView,
                  mcpsOpen: false,
                },
              }
            : current
        );
      }
    },
    [activeNav, updateWorkspaceSession]
  );

  const applySearchHit = useCallback(
    (hit: SettingsSearchEntry) => {
      const focus = settingsSearchHitToFocus(hit);
      const legacyMcpNav = hit.navId === "mcps" || hit.navId === "tools";
      const nextNav = legacyMcpNav ? "plugins" : hit.navId;
      const opensMcpsSubview =
        legacyMcpNav ||
        (nextNav === "plugins" &&
          (hit.rowId === "mcp-link" ||
            hit.id === "plugins::section::mcp-presets" ||
            hit.id === "plugins::section::mcp-custom" ||
            hit.id === "plugins::section::mcp-connected"));
      setActiveNav(nextNav);
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          activeNav: nextNav,
          agentsHarnessId:
            hit.kind === "harness" && hit.agentsHarnessId
              ? hit.agentsHarnessId
              : hit.navId === "agents" && hit.kind !== "harness"
                ? null
                : current.settingsView.agentsHarnessId ?? null,
          mcpsOpen: opensMcpsSubview,
          panelSearchFocus: focus
            ? focus.kind === "scroll"
              ? {
                  ...focus,
                  navId: legacyMcpNav ? "plugins" : focus.navId,
                }
              : focus
            : focus,
        },
      }));
      if (isMobile) {
        setNavDrawerOpen(false);
      }
    },
    [isMobile, updateWorkspaceSession]
  );

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!isSearching || searchResults.length === 0) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedResultIndex((index) => Math.min(index + 1, searchResults.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedResultIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const hit = searchResults[selectedResultIndex];
        if (hit) {
          applySearchHit(hit);
        }
      }
    },
    [applySearchHit, isSearching, searchResults, selectedResultIndex]
  );

  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("opencursor:focusSettingsSearch", onFocusSearch);
    return () => window.removeEventListener("opencursor:focusSettingsSearch", onFocusSearch);
  }, []);

  const navContent = (
    <SettingsNavContent
      activeNav={activeNav}
      searchQuery={searchQuery}
      searchModLabel={searchModLabel}
      searchResults={searchResults}
      isSearching={isSearching}
      selectedResultIndex={selectedResultIndex}
      searchInputRef={searchInputRef}
      onCloseShell={onCloseShell}
      onNavChange={handleNavChange}
      onSearchChange={setSearchQuery}
      onSearchKeyDown={onSearchKeyDown}
      onSelectSearchResult={applySearchHit}
      onOpenDocs={openDocumentation}
      closeMobileDrawer={closeMobileDrawer}
      isMobile={isMobile}
      padSettingsSearchForWindowChrome={padSettingsSearchForWindowChrome}
    />
  );

  if (isMobile) {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-main)]">
        {navDrawerOpen ? (
          <>
            <div
              className="absolute inset-0 z-30 bg-black/40"
              onClick={closeMobileDrawer}
            />
            <div
              className="absolute inset-y-0 left-0 z-40 overflow-hidden border-r border-[var(--border-subtle)] shadow-[0_0_40px_rgba(0,0,0,0.35)]"
              style={{ width: `${AGENT_LEFT_RAIL_EXPANDED_WIDTH}px` }}
            >
              {navContent}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setNavDrawerOpen(true)}
            className="absolute left-[11px] top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
            aria-label="Show settings nav"
          >
            <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
          </button>
        )}

        <main
          ref={scrollRootRef}
          className="hide-scrollbar-y min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)] py-[24px]"
          onScroll={onMainScroll}
        >
          <div className={SETTINGS_MAIN_CONTENT_SHELL_CLASS}>
            <DefaultServerSettingsBanner className="mb-[16px]" />
            {SettingsPanel ? <SettingsPanel /> : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <Group
      id="settings-shell-panels"
      groupRef={groupRef}
      key="settings-shell-desktop"
      orientation="horizontal"
      className="h-full min-w-0 bg-[var(--bg-main)]"
      defaultLayout={settingsDesktopLayout}
    >
      <Panel
        id={AGENT_SHELL_PANEL_IDS.rail}
        minSize={`${AGENT_SHELL_RAIL_MIN_PERCENT}%`}
        maxSize={`${AGENT_SHELL_RAIL_MAX_PERCENT}%`}
        onResize={(panelSize) => {
          if (applyingSettingsLayoutFromContextRef.current) {
            return;
          }
          persistSettingsRailWidth(panelSize.asPercentage);
        }}
        className="min-h-0 overflow-hidden border-r border-[var(--border-subtle)]"
      >
        <aside className="flex h-full min-h-0 w-full flex-col">{navContent}</aside>
      </Panel>
      <SettingsShellResizeHandle />

      <Panel
        id={AGENT_SHELL_PANEL_IDS.center}
        minSize={`${AGENT_SHELL_CENTER_MIN_PERCENT}%`}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <main
          ref={scrollRootRef}
          className="hide-scrollbar-y h-full min-h-0 min-w-0 overflow-y-auto bg-[var(--bg-main)] py-[24px]"
          onScroll={onMainScroll}
        >
          <div className={SETTINGS_MAIN_CONTENT_SHELL_CLASS}>
            <DefaultServerSettingsBanner className="mb-[16px]" />
            {SettingsPanel ? <SettingsPanel /> : null}
          </div>
        </main>
      </Panel>
    </Group>
  );
}
