"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { isCesiumDesktopApp } from "@/lib/desktop-environment";
import type {
  HardwareInputSurfaceAdapter,
  HardwareKeyRoutingResult,
} from "@/components/input/hardware-input-types";

type HardwareInputContextValue = {
  enabled: boolean;
  activeSurfaceId: string | null;
  registerSurface: (id: string, adapter: HardwareInputSurfaceAdapter) => void;
  unregisterSurface: (id: string) => void;
  activateSurface: (id: string, focusTarget?: HTMLElement | null) => void;
  deactivateSurface: (id?: string | null) => void;
  routeKeyDown: (event: KeyboardEvent) => HardwareKeyRoutingResult;
  handlePaste: (event: ClipboardEvent) => boolean;
  handleCopy: (event: ClipboardEvent) => boolean;
  handleCut: (event: ClipboardEvent) => boolean;
  isSurfaceActive: (id: string) => boolean;
};

const HardwareInputContext = createContext<HardwareInputContextValue | null>(
  null
);

function focusElement(target: HTMLElement | null | undefined) {
  if (!target) return;
  if (typeof target.focus !== "function") return;
  if (typeof document !== "undefined" && document.activeElement === target) {
    return;
  }

  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}

function normalizeRoutingResult(
  result: ReturnType<NonNullable<HardwareInputSurfaceAdapter["onKeyDown"]>>,
  allowWorkbenchShortcuts: boolean
): HardwareKeyRoutingResult {
  if (typeof result === "boolean") {
    return {
      handled: result,
      allowWorkbenchShortcuts,
    };
  }

  return {
    handled: result?.handled ?? false,
    allowWorkbenchShortcuts:
      result?.allowWorkbenchShortcuts ?? allowWorkbenchShortcuts,
  };
}

export function shouldEnableHardwareInputSurfaces(
  experimentalIpadMode: boolean
): boolean {
  return experimentalIpadMode && !isCesiumDesktopApp();
}

export function HardwareInputProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { experimentalIpadMode } = useUserPreferences();
  const hardwareInputSurfacesEnabled =
    shouldEnableHardwareInputSurfaces(experimentalIpadMode);
  const surfacesRef = useRef(new Map<string, HardwareInputSurfaceAdapter>());
  const fallbackFocusRef = useRef<HTMLDivElement>(null);
  const activeSurfaceIdRef = useRef<string | null>(null);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);

  const registerSurface = useCallback(
    (id: string, adapter: HardwareInputSurfaceAdapter) => {
      surfacesRef.current.set(id, adapter);
    },
    []
  );

  const deactivateSurface = useCallback((id?: string | null) => {
    const nextId = id ?? activeSurfaceIdRef.current;
    if (!nextId) return;

    const current = surfacesRef.current.get(nextId);
    current?.onDeactivate?.();

    if (activeSurfaceIdRef.current === nextId) {
      activeSurfaceIdRef.current = null;
      setActiveSurfaceId(null);
      focusElement(fallbackFocusRef.current);
    }
  }, []);

  const unregisterSurface = useCallback(
    (id: string) => {
      if (activeSurfaceIdRef.current === id) {
        deactivateSurface(id);
      }
      surfacesRef.current.delete(id);
    },
    [deactivateSurface]
  );

  const activateSurface = useCallback(
    (id: string, focusTarget?: HTMLElement | null) => {
      const next = surfacesRef.current.get(id);
      if (!next) return;

      const previousId = activeSurfaceIdRef.current;
      if (previousId && previousId !== id) {
        surfacesRef.current.get(previousId)?.onDeactivate?.();
      }

      activeSurfaceIdRef.current = id;
      setActiveSurfaceId(id);
      next.onActivate?.();

      if (!hardwareInputSurfacesEnabled) return;
      focusElement(focusTarget ?? next.focusTarget ?? fallbackFocusRef.current);
    },
    [hardwareInputSurfacesEnabled]
  );

  const routeKeyDown = useCallback(
    (event: KeyboardEvent): HardwareKeyRoutingResult => {
      if (!hardwareInputSurfacesEnabled) {
        return { handled: false, allowWorkbenchShortcuts: true };
      }

      const surfaceId = activeSurfaceIdRef.current;
      if (!surfaceId) {
        return { handled: false, allowWorkbenchShortcuts: true };
      }

      const surface = surfacesRef.current.get(surfaceId);
      if (!surface) {
        return { handled: false, allowWorkbenchShortcuts: true };
      }

      const allowWorkbenchShortcuts = surface.allowWorkbenchShortcuts ?? false;
      if (!surface.onKeyDown) {
        return { handled: false, allowWorkbenchShortcuts };
      }

      return normalizeRoutingResult(
        surface.onKeyDown(event),
        allowWorkbenchShortcuts
      );
    },
    [hardwareInputSurfacesEnabled]
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      if (!hardwareInputSurfacesEnabled) return false;

      const surface = activeSurfaceIdRef.current
        ? surfacesRef.current.get(activeSurfaceIdRef.current)
        : null;
      if (!surface?.onPaste) return false;

      const text = event.clipboardData?.getData("text/plain");
      if (typeof text !== "string") return false;
      if (!surface.onPaste(text)) return false;
      event.preventDefault();
      return true;
    },
    [hardwareInputSurfacesEnabled]
  );

  const writeClipboardText = useCallback(
    (
      event: ClipboardEvent,
      reader: ((surface: HardwareInputSurfaceAdapter) => string | null) | null
    ) => {
      if (!hardwareInputSurfacesEnabled || !reader) return false;

      const surface = activeSurfaceIdRef.current
        ? surfacesRef.current.get(activeSurfaceIdRef.current)
        : null;
      if (!surface || !event.clipboardData) return false;

      const text = reader(surface);
      if (text == null) return false;

      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
      return true;
    },
    [hardwareInputSurfacesEnabled]
  );

  const handleCopy = useCallback(
    (event: ClipboardEvent) =>
      writeClipboardText(event, (surface) => surface.onCopy?.() ?? null),
    [writeClipboardText]
  );

  const handleCut = useCallback(
    (event: ClipboardEvent) =>
      writeClipboardText(event, (surface) => surface.onCut?.() ?? null),
    [writeClipboardText]
  );

  const isSurfaceActive = useCallback(
    (id: string) => activeSurfaceId === id,
    [activeSurfaceId]
  );

  const value = useMemo(
    () => ({
      enabled: hardwareInputSurfacesEnabled,
      activeSurfaceId,
      registerSurface,
      unregisterSurface,
      activateSurface,
      deactivateSurface,
      routeKeyDown,
      handlePaste,
      handleCopy,
      handleCut,
      isSurfaceActive,
    }),
    [
      hardwareInputSurfacesEnabled,
      activeSurfaceId,
      registerSurface,
      unregisterSurface,
      activateSurface,
      deactivateSurface,
      routeKeyDown,
      handlePaste,
      handleCopy,
      handleCut,
      isSurfaceActive,
    ]
  );

  return (
    <HardwareInputContext.Provider value={value}>
      {children}
      <div
        ref={fallbackFocusRef}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
        data-hardware-input-fallback
      />
    </HardwareInputContext.Provider>
  );
}

export function useHardwareInput(): HardwareInputContextValue {
  const context = useContext(HardwareInputContext);
  if (!context) {
    throw new Error(
      "useHardwareInput must be used within HardwareInputProvider"
    );
  }
  return context;
}
