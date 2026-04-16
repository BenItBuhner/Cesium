"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useHardwareInput } from "@/components/input/HardwareInputProvider";
import {
  getTerminalSelectionText,
  handleTerminalHardwareKey,
  pasteIntoTerminal,
} from "@/components/editor/TerminalHardwareAdapter";
import { getServerBaseUrl } from "@/lib/server-api";
import { BinaryWebSocket, toWebSocketUrl } from "@/lib/ws-client";
import { buildAuthenticatedUrl } from "@/lib/auth-client";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";

interface TerminalProps {
  terminalId: string;
  /** When the user typed `exit` / `exit 0` and the shell exits with code 0, close the terminal tab. */
  onAutoCloseAfterCleanExit?: () => void;
}

const decoder = new TextDecoder();
const DEFAULT_CLEAR_COMMANDS = new Set(["clear", "cls", "clear-host", "reset"]);
const GEIST_MONO_FALLBACK =
  "'Geist Mono', 'Geist Mono Fallback', ui-monospace, monospace";

type TerminalServerMessage =
  | { type: "exit"; code: number | null }
  | { type: "metadata"; shell: string; clearCommands?: string[] }
  | { type: "pong" };

function readCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function getTerminalTheme(isDark: boolean) {
  const background = readCssVariable("--bg-main", isDark ? "#191919" : "#fafafa");
  const panel = readCssVariable("--bg-panel", isDark ? "#1e1e1e" : "#f0f0f0");
  const foreground = readCssVariable("--text-primary", isDark ? "#ffffff" : "#1a1a1a");
  const muted = readCssVariable("--text-secondary", isDark ? "#6f6f6f" : "#5c5c5c");
  const disabled = readCssVariable("--text-disabled", isDark ? "#5b5b5b" : "#9a9a9a");
  const accent = readCssVariable("--accent-dark", isDark ? "#e8e8e8" : "#333333");

  const ansiPalette = isDark
    ? {
        black: panel,
        red: "#e59a9a",
        green: "#8fbe99",
        yellow: "#d8ba57",
        blue: "#8eb4ff",
        magenta: "#c8a2e8",
        cyan: "#86cfd8",
        white: "#d4d4d4",
        brightBlack: muted,
        brightRed: "#f0b4b4",
        brightGreen: "#a8d8b2",
        brightYellow: "#e7ca72",
        brightBlue: "#a8c6ff",
        brightMagenta: "#d8b8f0",
        brightCyan: "#9adddf",
        brightWhite: foreground,
      }
    : {
        black: accent,
        red: "#9b3642",
        green: "#2f6b3e",
        yellow: "#6f5700",
        blue: "#0b5cab",
        magenta: "#7a3f7c",
        cyan: "#006b78",
        white: "#555555",
        brightBlack: muted,
        brightRed: "#7f2631",
        brightGreen: "#255a33",
        brightYellow: "#5f4a00",
        brightBlue: "#084d91",
        brightMagenta: "#663268",
        brightCyan: "#005963",
        brightWhite: foreground,
      };

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: isDark ? "rgba(255, 255, 255, 0.16)" : "rgba(0, 0, 0, 0.12)",
    selectionInactiveBackground: isDark
      ? "rgba(255, 255, 255, 0.1)"
      : "rgba(0, 0, 0, 0.08)",
    scrollbarSliderBackground: isDark
      ? "rgba(111, 111, 111, 0.28)"
      : "rgba(92, 92, 92, 0.22)",
    scrollbarSliderHoverBackground: isDark
      ? "rgba(111, 111, 111, 0.42)"
      : "rgba(92, 92, 92, 0.36)",
    scrollbarSliderActiveBackground: isDark
      ? "rgba(111, 111, 111, 0.54)"
      : "rgba(92, 92, 92, 0.48)",
    overviewRulerBorder: disabled,
    ...ansiPalette,
  };
}

function normalizeCommandName(line: string): string | null {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) return null;
  if (/[\s;&|<>]/.test(trimmed)) return null;
  return trimmed;
}

/** Matches a user-submitting the shell `exit` built-in for a successful exit (0 / default). */
function isUserExplicitExitCommand(line: string): boolean {
  const t = line.trim().toLowerCase();
  if (!t) return false;
  const m = /^exit(?:\s+(\d+))?$/.exec(t);
  if (!m) return false;
  if (m[1] === undefined) return true;
  return m[1] === "0";
}

export function Terminal({ terminalId, onAutoCloseAfterCleanExit }: TerminalProps) {
  const surfaceId = useId().replace(/:/g, "_");
  const {
    enabled: hardwareInputEnabled,
    registerSurface,
    unregisterSurface,
    activateSurface,
    deactivateSurface,
  } = useHardwareInput();
  const captureRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<BinaryWebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const clearCommandsRef = useRef(DEFAULT_CLEAR_COMMANDS);
  const pendingCommandRef = useRef("");
  const pendingClearRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const userRequestedExitRef = useRef(false);
  const onAutoCloseAfterCleanExitRef = useRef(onAutoCloseAfterCleanExit);
  const hardwareInputEnabledRef = useRef(hardwareInputEnabled);

  onAutoCloseAfterCleanExitRef.current = onAutoCloseAfterCleanExit;
  const [connectionState, setConnectionState] = useState("connecting");
  const [terminalReadyNonce, setTerminalReadyNonce] = useState(0);
  const isDark = useHtmlDarkClass();
  const initialThemeRef = useRef(getTerminalTheme(isDark));
  const serverBaseUrlRef = useRef(getServerBaseUrl());

  const socketUrl = useMemo(
    () =>
      buildAuthenticatedUrl(
        `${toWebSocketUrl(serverBaseUrlRef.current)}/ws/terminal/${terminalId}`,
        serverBaseUrlRef.current
      ),
    [terminalId]
  );

  useEffect(() => {
    hardwareInputEnabledRef.current = hardwareInputEnabled;
    if (!hardwareInputEnabled) return;
    const target = captureRef.current;
    if (!target) return;
    const activeElement = document.activeElement;
    if (activeElement && !target.contains(activeElement)) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }, [hardwareInputEnabled]);

  useEffect(() => {
    if (!containerRef.current) return;

    const focusTerminalTarget = () => {
      if (hardwareInputEnabledRef.current) {
        const target = captureRef.current;
        if (!target) return;
        try {
          target.focus({ preventScroll: true });
        } catch {
          target.focus();
        }
        return;
      }
      terminal.focus();
    };

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: readCssVariable("--font-geist-mono", GEIST_MONO_FALLBACK),
      fontSize: 12,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1,
      letterSpacing: 0,
      theme: initialThemeRef.current,
      convertEol: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    terminal.attachCustomKeyEventHandler(
      () => !hardwareInputEnabledRef.current
    );
    fitAddon.fit();
    requestAnimationFrame(focusTerminalTarget);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalReadyNonce((value) => value + 1);

    const socket = new BinaryWebSocket(socketUrl);
    socketRef.current = socket;

    const sendResize = () => {
      fitAddon.fit();
      socket.sendJson({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const syncTerminalMetrics = () => {
      fitAddon.fit();
      terminal.refresh(0, Math.max(terminal.rows - 1, 0));
      socket.sendJson({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const scheduleTerminalClear = () => {
      if (!pendingClearRef.current) return;
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
      }

      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null;
        if (!pendingClearRef.current) return;

        pendingClearRef.current = false;
        terminal.clear();
        socket.sendJson({ type: "clear" });
        focusTerminalTarget();
      }, 80);
    };

    const onTerminalInput = (data: string) => {
      for (const char of data) {
        if (char === "\r") {
          const lineSnapshot = pendingCommandRef.current;
          const maybeCommand = normalizeCommandName(lineSnapshot);
          pendingCommandRef.current = "";

          if (isUserExplicitExitCommand(lineSnapshot)) {
            userRequestedExitRef.current = true;
          }

          if (maybeCommand && clearCommandsRef.current.has(maybeCommand)) {
            pendingClearRef.current = true;
            scheduleTerminalClear();
          }
          continue;
        }

        if (char === "\u0003" || char === "\u0015") {
          pendingCommandRef.current = "";
          pendingClearRef.current = false;
          continue;
        }

        if (char === "\u007f" || char === "\b") {
          pendingCommandRef.current = pendingCommandRef.current.slice(0, -1);
          continue;
        }

        if (char < " " || char === "\u001b") {
          continue;
        }

        pendingCommandRef.current += char;
      }
    };

    const unsubscribers = [
      socket.onState((state) => {
        setConnectionState(state);
        if (state === "open") {
          userRequestedExitRef.current = false;
          terminal.reset();
          sendResize();
          requestAnimationFrame(focusTerminalTarget);
        }
      }),
      socket.onMessage((message) => {
        if (message instanceof ArrayBuffer) {
          terminal.write(decoder.decode(new Uint8Array(message)));
          scheduleTerminalClear();
          return;
        }

        if (typeof message === "object" && message) {
          const serverMessage = message as TerminalServerMessage;

          if (serverMessage.type === "metadata") {
            clearCommandsRef.current = new Set(
              (serverMessage.clearCommands ?? [...DEFAULT_CLEAR_COMMANDS]).map((command) =>
                command.toLowerCase()
              )
            );
            return;
          }

          if (serverMessage.type === "exit") {
            const closeTab = onAutoCloseAfterCleanExitRef.current;
            const shouldAutoClose =
              serverMessage.code === 0 &&
              userRequestedExitRef.current &&
              typeof closeTab === "function";
            userRequestedExitRef.current = false;
            if (shouldAutoClose) {
              closeTab();
              return;
            }
            terminal.writeln(`\r\n[Process exited with code ${serverMessage.code}]`);
            return;
          }

          return;
        }
        if (typeof message === "string") {
          terminal.write(message);
          scheduleTerminalClear();
        }
      }),
    ];

    const disposable = terminal.onData((data) => {
      onTerminalInput(data);
      socket.sendBinary(data);
    });

    resizeObserverRef.current = new ResizeObserver(() => {
      sendResize();
    });
    resizeObserverRef.current.observe(containerRef.current);

    let cancelled = false;
    const fontSet = document.fonts;
    const onFontsSettled = () => {
      if (cancelled) return;
      requestAnimationFrame(syncTerminalMetrics);
    };

    void fontSet.ready.then(onFontsSettled);
    fontSet.addEventListener?.("loadingdone", onFontsSettled);
    fontSet.addEventListener?.("loadingerror", onFontsSettled);

    socket.connect();

    return () => {
      cancelled = true;
      fontSet.removeEventListener?.("loadingdone", onFontsSettled);
      fontSet.removeEventListener?.("loadingerror", onFontsSettled);
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      pendingCommandRef.current = "";
      pendingClearRef.current = false;
      userRequestedExitRef.current = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      disposable.dispose();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      socket.disconnect();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [socketUrl]);

  useEffect(() => {
    if (!hardwareInputEnabled || !terminalRef.current) {
      unregisterSurface(surfaceId);
      return;
    }

    const terminal = terminalRef.current;
    registerSurface(surfaceId, {
      id: surfaceId,
      kind: "terminal",
      allowWorkbenchShortcuts: true,
      focusTarget: captureRef.current,
      onKeyDown: (event) => handleTerminalHardwareKey(terminal, event),
      onPaste: (text) => pasteIntoTerminal(terminal, text),
      onCopy: () => getTerminalSelectionText(terminal),
      onCut: () => null,
    });

    return () => unregisterSurface(surfaceId);
  }, [
    hardwareInputEnabled,
    registerSurface,
    surfaceId,
    terminalReadyNonce,
    unregisterSurface,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = getTerminalTheme(isDark);
    requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [isDark]);

  return (
    <div
      ref={captureRef}
      className="relative h-full w-full bg-[var(--bg-main)] outline-none"
      tabIndex={hardwareInputEnabled ? 0 : -1}
      data-hardware-input-surface={hardwareInputEnabled ? "" : undefined}
      data-hardware-surface-kind={hardwareInputEnabled ? "terminal" : undefined}
      onFocus={() => {
        if (hardwareInputEnabled) {
          activateSurface(surfaceId, captureRef.current);
        }
      }}
      onBlur={() => {
        if (hardwareInputEnabled) {
          deactivateSurface(surfaceId);
        }
      }}
      onPointerDownCapture={(event) => {
        if (hardwareInputEnabled) {
          activateSurface(surfaceId, captureRef.current);
          event.preventDefault();
          return;
        }
        terminalRef.current?.focus();
      }}
    >
      {connectionState !== "open" ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-2 py-1 font-sans text-[11px] text-[var(--text-secondary)]">
          {connectionState === "reconnecting" ? "Reconnecting..." : "Connecting..."}
        </div>
      ) : null}
      <div ref={containerRef} className="h-full w-full px-2 py-2" />
    </div>
  );
}
