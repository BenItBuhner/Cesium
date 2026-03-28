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
  BookMarked,
  Bot,
  Box,
  Download,
  ExternalLink,
  FlaskConical,
  Keyboard,
  Palette,
  Settings,
  User,
  Wrench,
} from "lucide-react";
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
  { kind: "divider" },
  { kind: "item", id: "rulesSkills", label: "Rules, Skills, Subagents", icon: BookMarked },
  { kind: "item", id: "tools", label: "Tools & MCPs", icon: Wrench },
  { kind: "item", id: "exportImport", label: "Import & export", icon: Download },
  { kind: "item", id: "beta", label: "Beta", icon: FlaskConical },
];

const searchInputClass =
  "box-border h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] leading-none text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const navItemClass =
  "flex h-[32px] w-full items-center gap-[10px] rounded-[var(--radius-tab)] px-[10px] text-left font-sans text-[13px] leading-none transition-colors";

export function SettingsEditorView() {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [activeNav, setActiveNav] = useState(workspaceSession.settingsView.activeNav);
  const [searchQuery, setSearchQuery] = useState(workspaceSession.settingsView.searchQuery);
  const scrollRootRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    root.scrollTop = workspaceSession.settingsView.scrollTop;
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
      const scrollTop = el.scrollTop;
      updateWorkspaceSession((current) => ({
        ...current,
        settingsView: {
          ...current.settingsView,
          scrollTop,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--bg-main)]">
      <aside className="flex w-[min(100%,268px)] shrink-0 flex-col bg-[var(--bg-main)]">
        <div className="flex items-center gap-[10px] px-[10px] pb-[10px] pt-[12px]">
          <div
            className="flex size-[32px] shrink-0 items-center justify-center rounded-full border border-[var(--border-card)] text-[var(--text-secondary)]"
            aria-hidden
          >
            <User className="size-[18px]" strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
              you@opencursor.demo
            </p>
            <p className="font-sans text-[11px] text-[var(--text-secondary)]">Demo plan</p>
          </div>
        </div>

        <div className="px-[10px] pb-[8px]">
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
