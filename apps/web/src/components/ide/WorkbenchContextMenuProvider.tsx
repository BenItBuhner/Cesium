"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "@/hooks/useClickOutside";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";

function isSep(item: WorkbenchMenuItem): item is { type: "sep" } {
  return item.type === "sep";
}

const MENU_MIN_W = 200;
const MENU_MAX_W = 320;
const VIEWPORT_PAD = 8;

type WorkbenchContextMenuValue = {
  openAt: (e: React.MouseEvent, items: WorkbenchMenuItem[]) => void;
  openAtPoint: (clientX: number, clientY: number, items: WorkbenchMenuItem[]) => void;
  close: () => void;
};

const WorkbenchContextMenuContext =
  createContext<WorkbenchContextMenuValue | null>(null);

export function WorkbenchContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    x: number;
    y: number;
    items: WorkbenchMenuItem[];
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setState(null), []);

  const openAtPoint = useCallback(
    (clientX: number, clientY: number, items: WorkbenchMenuItem[]) => {
      setState({ x: clientX, y: clientY, items });
    },
    []
  );

  const openAt = useCallback(
    (e: React.MouseEvent, items: WorkbenchMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      openAtPoint(e.clientX, e.clientY, items);
    },
    [openAtPoint]
  );

  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    let left = state.x;
    let top = state.y;
    if (left + rect.width > window.innerWidth - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, window.innerWidth - rect.width - VIEWPORT_PAD);
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, window.innerHeight - rect.height - VIEWPORT_PAD);
    }
    if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
    if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [state]);

  useClickOutside(menuRef, close, Boolean(state));

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state, close]);

  useEffect(() => {
    if (!state || !menuRef.current) return;
    const first = menuRef.current.querySelector<HTMLButtonElement>(
      "button[role='menuitem']:not([disabled])"
    );
    requestAnimationFrame(() => first?.focus());
  }, [state]);

  const value = useMemo<WorkbenchContextMenuValue>(
    () => ({ openAt, openAtPoint, close }),
    [openAt, openAtPoint, close]
  );

  const panelStyle = {
    left: state?.x ?? 0,
    top: state?.y ?? 0,
    "--menu-min-w": `${MENU_MIN_W}px`,
    "--menu-max-w": `${MENU_MAX_W}px`,
  } as CSSProperties;

  return (
    <WorkbenchContextMenuContext.Provider value={value}>
      {children}
      {state
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Context menu"
              className="fixed z-[10050] min-w-[var(--menu-min-w)] max-w-[var(--menu-max-w)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] py-[4px] shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_10px_28px_rgba(0,0,0,0.45)]"
              style={panelStyle}
            >
              {state.items.map((item, i) => {
                if (isSep(item)) {
                  return (
                    <div
                      key={`sep-${i}`}
                      role="separator"
                      className="my-[4px] h-px bg-[var(--border-subtle)]"
                    />
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      if (item.disabled) return;
                      item.onSelect();
                      close();
                    }}
                    className="flex w-full cursor-default items-center justify-between gap-[8px] px-[10px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span>{item.label}</span>
                    {item.shortcut ? (
                      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
                        {item.shortcut}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </WorkbenchContextMenuContext.Provider>
  );
}

export function useWorkbenchContextMenu(): WorkbenchContextMenuValue {
  const ctx = useContext(WorkbenchContextMenuContext);
  if (!ctx) {
    throw new Error(
      "useWorkbenchContextMenu must be used within WorkbenchContextMenuProvider"
    );
  }
  return ctx;
}
