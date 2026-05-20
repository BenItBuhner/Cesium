"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Menu } from "lucide-react";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
  type ShortcutPlatform,
} from "@/lib/keyboard-shortcuts";
import {
  popoverMenuItemClass,
  popoverMenuItemShortcutClass,
  popoverMenuListClass,
  popoverMenuPanelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";

type MenuLeaf = { cmd: string; label: string };
type MenuBlock = { sep: true } | MenuLeaf;

const FILE_MENU: MenuBlock[] = [
  { cmd: "workbench.action.newAgent", label: "New Agent" },
  { cmd: "workbench.action.newWindow", label: "New Window..." },
  { cmd: "workbench.action.openFolder", label: "Open Folder" },
  { cmd: "workbench.action.createWorkspace", label: "Create Workspace" },
  { cmd: "workbench.action.setDefaultWorkspace", label: "Set as Default" },
  { sep: true },
  { cmd: "workbench.action.terminal.toggleTerminal", label: "New Terminal" },
  { cmd: "workbench.action.newBrowser", label: "New Browser" },
  { sep: true },
  { cmd: "workbench.action.exit", label: "Exit" },
];

const VIEW_MENU: MenuBlock[] = [
  { cmd: "workbench.action.toggleAgentPanel", label: "Open Browser" },
  { cmd: "workbench.action.gotoFile", label: "Open File" },
  { cmd: "workbench.action.togglePanel", label: "Open Terminal" },
  { sep: true },
  { cmd: "workbench.action.openGlobalSettings", label: "Settings" },
];

const WINDOW_MENU: MenuBlock[] = [
  { cmd: "workbench.action.newWindow", label: "New Window..." },
  { cmd: "workbench.action.window.manage", label: "Workspace Windows..." },
];

function isSep(b: MenuBlock): b is { sep: true } {
  return "sep" in b && b.sep === true;
}

const subWrapBase =
  "invisible absolute left-full top-0 z-[60] hidden min-h-full pl-[6px]";

function SubmenuItems({
  blocks,
  onPick,
  bindings,
  platform,
}: {
  blocks: MenuBlock[];
  onPick: (cmd: string) => void;
  bindings: Record<string, string[]>;
  platform: ShortcutPlatform;
}) {
  return (
    <div className={`min-w-[248px] ${popoverMenuPanelClass}`} role="presentation">
      <div className={popoverMenuListClass}>
        {blocks.map((b, i) =>
          isSep(b) ? (
            <div key={`s-${i}`} className={popoverMenuSeparatorClass} role="separator" />
          ) : (
            <button
              key={b.cmd}
              type="button"
              role="menuitem"
              className={popoverMenuItemClass}
              onClick={() => onPick(b.cmd)}
            >
              <span className="min-w-0 flex-1">{b.label}</span>
              {(() => {
                const shortcut = getShortcutDisplayForCommand(
                  bindings,
                  b.cmd,
                  platform
                );
                return shortcut ? (
                  <span className={popoverMenuItemShortcutClass}>{shortcut}</span>
                ) : null;
              })()}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function FileSubmenu({
  onPick,
  bindings,
  platform,
}: {
  onPick: (cmd: string) => void;
  bindings: Record<string, string[]>;
  platform: ShortcutPlatform;
}) {
  return (
    <div className="group/file relative w-full">
      <div className={popoverMenuItemClass} role="presentation">
        <span>File</span>
        <ChevronRight
          className="size-[14px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div
        className={`${subWrapBase} group-hover/file:visible group-hover/file:block`}
      >
        <SubmenuItems
          blocks={FILE_MENU}
          onPick={onPick}
          bindings={bindings}
          platform={platform}
        />
      </div>
    </div>
  );
}

function ViewSubmenu({
  onPick,
  bindings,
  platform,
}: {
  onPick: (cmd: string) => void;
  bindings: Record<string, string[]>;
  platform: ShortcutPlatform;
}) {
  return (
    <div className="group/view relative w-full">
      <div className={popoverMenuItemClass} role="presentation">
        <span>View</span>
        <ChevronRight
          className="size-[14px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div
        className={`${subWrapBase} group-hover/view:visible group-hover/view:block`}
      >
        <SubmenuItems
          blocks={VIEW_MENU}
          onPick={onPick}
          bindings={bindings}
          platform={platform}
        />
      </div>
    </div>
  );
}

function WindowSubmenu({
  onPick,
  bindings,
  platform,
}: {
  onPick: (cmd: string) => void;
  bindings: Record<string, string[]>;
  platform: ShortcutPlatform;
}) {
  return (
    <div className="group/window relative w-full">
      <div className={popoverMenuItemClass} role="presentation">
        <span>Window</span>
        <ChevronRight
          className="size-[14px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div
        className={`${subWrapBase} group-hover/window:visible group-hover/window:block`}
      >
        <SubmenuItems
          blocks={WINDOW_MENU}
          onPick={onPick}
          bindings={bindings}
          platform={platform}
        />
      </div>
    </div>
  );
}

/** Below command palette (10050), above editor/split panels. */
const PORTAL_Z = 10048;

export function SidebarAppMenu() {
  const runCommand = useIDECommandRunner();
  const { settings } = useGlobalSettings();
  const bindings = settings.keyboardShortcuts.bindings;
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setMounted(true);
  }, []);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (portalRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const onPick = useCallback(
    (cmd: string) => {
      runCommand?.(cmd);
      close();
    },
    [runCommand, close]
  );

  const menuPanel =
    open && mounted ? (
      <div
        ref={portalRef}
        className={`fixed w-[132px] overflow-visible ${popoverMenuPanelClass}`}
        style={{ top: pos.top, left: pos.left, zIndex: PORTAL_Z }}
        role="menu"
        aria-label="Application menu"
        data-ide-sidebar-app-menu
      >
        <div className={popoverMenuListClass}>
        <FileSubmenu onPick={onPick} bindings={bindings} platform={platform} />
        <ViewSubmenu onPick={onPick} bindings={bindings} platform={platform} />
        <WindowSubmenu onPick={onPick} bindings={bindings} platform={platform} />
        </div>
      </div>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Application menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className={`flex size-[30px] shrink-0 items-center justify-center rounded-[4px] outline-none transition-colors focus-visible:outline-none ${
          open
            ? "text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        }`}
      >
        <Menu className="size-[18px]" strokeWidth={open ? 2 : 1.5} aria-hidden />
      </button>

      {mounted && menuPanel ? createPortal(menuPanel, document.body) : null}
    </>
  );
}
