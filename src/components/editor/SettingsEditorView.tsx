"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookMarked,
  Bot,
  Box,
  CircleUserRound,
  Database,
  Download,
  ExternalLink,
  FlaskConical,
  Keyboard,
  Palette,
  Puzzle,
  Server,
  Settings,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { SETTINGS_PANELS } from "@/components/editor/settings-panels";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { detectShortcutPlatform, primaryModifierLabel } from "@/lib/keyboard-shortcuts";

type NavEntry =
  | { kind: "item"; id: string; label: string; icon: LucideIcon }
  | { kind: "divider" };

/** In-app documentation (template); opened in a new browser tab so the IDE tab stays put. */
const DOCS_PATH = "/docs";

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
  { kind: "item", id: "tools", label: "Tools & MCPs", icon: Wrench },
  { kind: "item", id: "exportImport", label: "Import & export", icon: Download },
  { kind: "item", id: "storage", label: "Storage", icon: Database },
  { kind: "item", id: "beta", label: "Beta", icon: FlaskConical },
];

const searchInputClass =
  "box-border h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const navItemClass =
  "flex h-[32px] w-full items-center gap-[10px] rounded-[var(--radius-tab)] px-[10px] text-left font-sans text-[13px] leading-none transition-colors";

export type SettingsEditorViewProps = {
  /** Full-screen settings shell: icon-only back control in the sidebar footer. */
  onCloseShell?: () => void;
};

export function SettingsEditorView({ onCloseShell }: SettingsEditorViewProps = {}) {
  const { session: authSession } = useAuth();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const accountLabel = authSession?.username?.trim() || "Guest";
  const [activeNav, setActiveNav] = useState(workspaceSession.settingsView.activeNav);
  const [searchQuery, setSearchQuery] = useState(workspaceSession.settingsView.searchQuery);
  const scrollRootRef = useRef<HTMLElement | null>(null);
  const scrollPersistTimerRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(workspaceSession.settingsView.scrollTop);
  const persistedScrollTopRef = useRef<number | null>(null);
  const Panel = SETTINGS_PANELS[activeNav] ?? SETTINGS_PANELS.general;
  const searchModLabel = useMemo(
    () => primaryModifierLabel(detectShortcutPlatform()),
    []
  );

  useEffect(() => {
    setActiveNav(workspaceSession.settingsView.activeNav);
    setSearchQuery(workspaceSession.settingsView.searchQuery);
  }, [workspaceSession.settingsView.activeNav, workspaceSession.settingsView.searchQuery]);

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

  const openDocsInNewTab = useCallback(() => {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}${DOCS_PATH}`
        : DOCS_PATH;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  /** `currentTarget` on synthetic events can be cleared before React runs the state updater — read scrollTop now. */
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

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--bg-main)]">
      <aside className="flex w-[min(100%,268px)] shrink-0 flex-col bg-[var(--bg-main)]">
        <div className="px-[10px] pb-[8px] pt-[12px]">
          <HardwareAwareTextInput
            type="search"
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={`Search settings ${searchModLabel}+F`}
            className={searchInputClass}
            ariaLabel="Search settings"
          />
        </div>

        <nav
          className="hide-scrollbar-y min-h-0 flex-1 overflow-y-auto px-[10px] pb-[12px]"
          aria-label="Settings categories"
        >
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
                onClick={() => setActiveNav(entry.id)}
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
            onClick={openDocsInNewTab}
            className={`${navItemClass} font-normal text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]`}
            title="Open documentation in a new browser tab"
          >
            <ExternalLink className="size-[16px] shrink-0" strokeWidth={1.5} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">Docs</span>
          </button>
        </nav>

        <div className="flex shrink-0 items-center gap-[8px] px-[10px] py-[10px]">
          <div
            className="flex min-w-0 flex-1 items-center gap-[10px] rounded-[var(--radius-tab)] px-[10px] py-[8px]"
            title={accountLabel}
          >
            <CircleUserRound
              className="size-[18px] shrink-0 text-[var(--text-secondary)]"
              strokeWidth={1.5}
              aria-hidden
            />
            <span className="min-w-0 truncate font-sans text-[13px] text-[var(--text-primary)]">
              {accountLabel}
            </span>
          </div>
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
      </aside>

      <main
        ref={scrollRootRef}
        className="hide-scrollbar-y min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)] px-[28px] py-[24px]"
        onScroll={onMainScroll}
      >
        {Panel ? <Panel /> : null}
      </main>
    </div>
  );
}
