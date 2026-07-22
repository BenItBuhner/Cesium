"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  detectShortcutPlatform,
  formatShortcutBinding,
  formatShortcutBindingsForInput,
  normalizeKeyForCapture,
  SHORTCUT_COMMAND_DEFINITIONS,
  type ShortcutCommandSection,
  type ShortcutPlatform,
  type VoiceInputMode,
} from "@/lib/keyboard-shortcuts";
import {
  PageIntro,
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { panelSearchInputClass } from "./shared";

const SECTION_ORDER: ShortcutCommandSection[] = [
  "Workbench",
  "Chat",
  "File",
  "Editor",
  "Edit",
  "Search",
  "Terminal",
  "Window",
  "Developer",
];

const keycapClass =
  "inline-flex items-center rounded-[4px] border border-[var(--border-card)] bg-[var(--bg-main)] px-[6px] py-[2px] font-mono text-[11px] font-medium text-[var(--text-primary)] leading-tight";

function ShortcutKeycapGroup({
  binding,
  platform,
}: {
  binding: string;
  platform: ShortcutPlatform;
}) {
  const parsed = formatShortcutBinding(binding, platform);
  if (!parsed) return null;
  const tokens = parsed.split("+");
  return (
    <span className="inline-flex items-center gap-[3px]">
      {tokens.map((token, i) => (
        <kbd key={i} className={keycapClass}>{token}</kbd>
      ))}
    </span>
  );
}

function ShortcutKeyCapture({
  commandId,
  bindings,
  defaultBindings,
  platform,
  onCommitBinding,
  onReset,
}: {
  commandId: string;
  bindings: string[];
  defaultBindings: string[];
  platform: ShortcutPlatform;
  onCommitBinding: (bindings: string[]) => void;
  onReset: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const isDefault =
    bindings.length === defaultBindings.length &&
    bindings.every((b, i) => b === defaultBindings[i]);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("Mod");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      parts.push(normalizeKeyForCapture(e.key));
      const binding = parts.join("+");
      setCapturing(false);
      onCommitBinding([binding]);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, onCommitBinding]);

  return (
    <div className="flex flex-wrap items-center justify-end gap-[8px]">
      <div
        ref={captureRef}
        role="button"
        tabIndex={0}
        onClick={() => setCapturing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCapturing(true);
          }
        }}
        className={`inline-flex cursor-pointer flex-wrap items-center justify-end gap-[6px] rounded-[var(--radius-tab)] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          capturing ? "opacity-100" : "hover:opacity-80"
        }`}
        aria-label={capturing ? `Press shortcut for ${commandId}` : `Shortcuts for ${commandId}. Click to change.`}
      >
        {capturing ? (
          <span className="font-sans text-[11px] italic text-[var(--accent)]">
            Press shortcut…
          </span>
        ) : bindings.length > 0 ? (
          bindings.map((binding, i) => (
            <ShortcutKeycapGroup
              key={i}
              binding={binding}
              platform={platform}
            />
          ))
        ) : (
          <span className="font-sans text-[11px] text-[var(--text-disabled)]">
            No binding
          </span>
        )}
      </div>
      {!isDefault && (
        <button type="button" className={rowButtonClass} onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}

type ShortcutCommandDef = (typeof SHORTCUT_COMMAND_DEFINITIONS)[number];

function shortcutBindingsHaystack(
  bindingList: string[],
  platform: ShortcutPlatform
): string {
  return bindingList
    .flatMap((binding) => [binding, formatShortcutBinding(binding, platform)])
    .join(" ")
    .toLowerCase();
}

function shortcutDefinitionMatchesQuery(
  def: ShortcutCommandDef,
  bindings: Record<string, string[]>,
  platform: ShortcutPlatform,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (def.label.toLowerCase().includes(q)) return true;
  if (def.id.toLowerCase().includes(q)) return true;
  if (def.section.toLowerCase().includes(q)) return true;

  const currentBindings =
    bindings[def.id] ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[def.id] ?? [];
  if (shortcutBindingsHaystack(currentBindings, platform).includes(q)) {
    return true;
  }
  if (shortcutBindingsHaystack(def.defaultBindings, platform).includes(q)) {
    return true;
  }

  const formattedCurrent = formatShortcutBindingsForInput(
    currentBindings,
    platform
  );
  if (formattedCurrent.toLowerCase().includes(q)) return true;

  return false;
}

export function KeyboardShortcutsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const bindings = settings.keyboardShortcuts.bindings;
  const voiceInputMode = settings.keyboardShortcuts.voiceInputMode;
  const [shortcutQuery, setShortcutQuery] = useState("");

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (focus?.kind !== "keyboardShortcuts") {
      return;
    }
    setShortcutQuery(focus.query);
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        panelSearchFocus: null,
      },
    }));
  }, [updateWorkspaceSession, workspaceSession.settingsView.panelSearchFocus]);
  const [expandedCategories, setExpandedCategories] = useState<
    Set<ShortcutCommandSection>
  >(new Set());

  const bySection = useMemo(() => {
    const map = new Map<ShortcutCommandSection, ShortcutCommandDef[]>();
    for (const def of SHORTCUT_COMMAND_DEFINITIONS) {
      const list = map.get(def.section) ?? [];
      list.push(def);
      map.set(def.section, list);
    }
    return map;
  }, []);

  const isFiltering = shortcutQuery.trim().length > 0;

  const filteredBySection = useMemo(() => {
    if (!isFiltering) {
      return bySection;
    }
    const result = new Map<ShortcutCommandSection, ShortcutCommandDef[]>();
    for (const [section, defs] of bySection) {
      const filtered = defs.filter((def) =>
        shortcutDefinitionMatchesQuery(def, bindings, platform, shortcutQuery)
      );
      if (filtered.length > 0) {
        result.set(section, filtered);
      }
    }
    return result;
  }, [bindings, bySection, isFiltering, platform, shortcutQuery]);

  const visibleSections = useMemo(
    () => SECTION_ORDER.filter((section) => filteredBySection.has(section)),
    [filteredBySection]
  );

  const commitBinding = useCallback(
    (commandId: string, newBindings: string[]) => {
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          bindings: {
            ...current.keyboardShortcuts.bindings,
            [commandId]: newBindings,
          },
        },
      }));
    },
    [updateSettings]
  );

  const resetBinding = useCallback(
    (commandId: string) => {
      const fallback = DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[commandId] ?? [];
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          bindings: {
            ...current.keyboardShortcuts.bindings,
            [commandId]: [...fallback],
          },
        },
      }));
    },
    [updateSettings]
  );

  const toggleCategoryCollapse = useCallback((section: ShortcutCommandSection) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const setVoiceInputMode = useCallback(
    (mode: VoiceInputMode) => {
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          voiceInputMode: mode,
        },
      }));
    },
    [updateSettings]
  );

  return (
    <>
      <PageIntro title="Keyboard shortcuts" />
      <div className="mb-[16px]">
        <HardwareAwareTextInput
          type="search"
          value={shortcutQuery}
          onChange={setShortcutQuery}
          placeholder="Search shortcuts"
          className={panelSearchInputClass}
          ariaLabel="Search keyboard shortcuts"
        />
      </div>
      {isFiltering && visibleSections.length === 0 ? (
        <SettingsEmptyState>No shortcuts match your search</SettingsEmptyState>
      ) : null}
      {visibleSections.map((section) => {
        const defs = filteredBySection.get(section);
        if (!defs?.length) return null;
        const allDefs = bySection.get(section) ?? defs;
        const collapsed = isFiltering ? false : !expandedCategories.has(section);
        const assignedCount = allDefs.filter((d) => {
          const b = bindings[d.id] ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[d.id] ?? [];
          return b.length > 0;
        }).length;
        return (
          <SettingsSection
            key={section}
            title={section}
            action={
              isFiltering ? (
                <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                  {defs.length} {defs.length === 1 ? "match" : "matches"}
                </span>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={() => toggleCategoryCollapse(section)}
                >
                  <span>
                    {assignedCount}/{allDefs.length}
                  </span>
                  <ChevronRight
                    className={`size-[14px] shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                    strokeWidth={1.5}
                  />
                </button>
              )
            }
          >
            {collapsed ? null : defs.map((def) => {
              const currentBindings =
                bindings[def.id] ??
                DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[def.id] ??
                [];
              const isVoiceCommand = def.id === "chat.action.toggleVoiceInput";
              return (
                <div key={def.id}>
                  <SettingsRow
                    title={def.label}
                    description={
                      def.defaultBindings.length > 0
                        ? `${def.id} · Default: ${formatShortcutBindingsForInput(def.defaultBindings, platform)}`
                        : def.id
                    }
                    border={!isVoiceCommand}
                    trailing={
                      <ShortcutKeyCapture
                        commandId={def.id}
                        platform={platform}
                        bindings={currentBindings}
                        defaultBindings={def.defaultBindings}
                        onCommitBinding={(b) => commitBinding(def.id, b)}
                        onReset={() => resetBinding(def.id)}
                      />
                    }
                  />
                  {isVoiceCommand && (
                    <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-[16px] py-[10px]">
                      <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                        Recording mode
                      </span>
                      <div className="flex items-center gap-[8px]">
                        <span
                          className={`font-sans text-[12px] ${
                            voiceInputMode === "toggle"
                              ? "text-[var(--text-primary)]"
                              : "text-[var(--text-disabled)]"
                          }`}
                        >
                          Toggle
                        </span>
                        <ToggleSwitch
                          checked={voiceInputMode === "hold"}
                          onChange={(isHold) =>
                            setVoiceInputMode(isHold ? "hold" : "toggle")
                          }
                          size="sm"
                          variant="green"
                        />
                        <span
                          className={`font-sans text-[12px] ${
                            voiceInputMode === "hold"
                              ? "text-[var(--text-primary)]"
                              : "text-[var(--text-disabled)]"
                          }`}
                        >
                          Hold
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </SettingsSection>
        );
      })}
    </>
  );
}
