"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getServerBaseUrl } from "@/lib/server-api";
import { BinaryWebSocket, toWebSocketUrl } from "@/lib/ws-client";
import { useHtmlDarkClass } from "@/hooks/useHtmlDarkClass";

interface TerminalProps {
  terminalId: string;
}

const decoder = new TextDecoder();
const DEFAULT_CLEAR_COMMANDS = new Set(["clear", "cls", "clear-host", "reset"]);
const TERMINAL_FONT_FAMILY = [
  '"Cascadia Mono"',
  '"Cascadia Code"',
  "Consolas",
  '"SFMono-Regular"',
  "Menlo",
  "Monaco",
  '"Liberation Mono"',
  '"DejaVu Sans Mono"',
  '"Courier New"',
  "monospace",
].join(", ");

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

export function Terminal({ terminalId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<BinaryWebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const clearCommandsRef = useRef(DEFAULT_CLEAR_COMMANDS);
  const pendingCommandRef = useRef("");
  const pendingClearRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const [connectionState, setConnectionState] = useState("connecting");
  const isDark = useHtmlDarkClass();
  const initialThemeRef = useRef(getTerminalTheme(isDark));

  const socketUrl = useMemo(
    () => `${toWebSocketUrl(getServerBaseUrl())}/ws/terminal/${terminalId}`,
    [terminalId]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
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
    fitAddon.fit();
    requestAnimationFrame(() => terminal.focus());

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

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
        terminal.focus();
      }, 80);
    };

    const onTerminalInput = (data: string) => {
      for (const char of data) {
        if (char === "\r") {
          const maybeCommand = normalizeCommandName(pendingCommandRef.current);
          pendingCommandRef.current = "";

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
          terminal.reset();
          sendResize();
          requestAnimationFrame(() => terminal.focus());
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
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = getTerminalTheme(isDark);
    requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [isDark]);

  return (
    <div
      className="relative h-full w-full bg-[var(--bg-main)]"
      onMouseDown={() => terminalRef.current?.focus()}
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
