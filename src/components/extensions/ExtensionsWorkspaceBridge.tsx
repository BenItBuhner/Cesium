"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Loader2 } from "lucide-react";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { VSCodeQuickInputShell } from "@/components/ide/VSCodeQuickInputShell";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  acquireExtensionSocket,
  releaseExtensionSocket,
  type ExtensionWorkspaceSocket,
} from "@/lib/extensions/extension-socket";
import {
  applyExtensionDiagnostics,
  applyExtensionTextEdits,
  clearExtensionDiagnostics,
} from "@/lib/extensions/editor-service";
import {
  replaceExtensionContextKeys,
  setExtensionContextKey,
} from "@/lib/extensions/when-clause";
import {
  executeInstalledExtensionCommand,
  fetchWorkspaceExtensionUiState,
  type ExtensionDiagnosticEntry,
  type ExtensionStatusBarItem,
  type ExtensionUiRequest,
  type WorkspaceExtensionEvent,
} from "@/lib/server-api";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
};

function stripCodicons(text: string): { text: string; spinning: boolean } {
  const spinning = /\$\((?:sync~spin|loading~spin|gear~spin)\)/.test(text);
  return { text: text.replace(/\$\([^)]*\)/g, "").trim(), spinning };
}

/* ------------------------------------------------------------------ */
/* Quick input overlay                                                 */
/* ------------------------------------------------------------------ */

function ExtensionQuickInputOverlay({
  request,
  socket,
  onDone,
}: {
  request: ExtensionUiRequest;
  socket: ExtensionWorkspaceSocket | null;
  onDone: (requestId: string) => void;
}) {
  const [value, setValue] = useState(request.value ?? "");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set((request.items ?? []).filter((item) => item.picked).map((item) => item.index))
  );
  const resolvedRef = useRef(false);

  const isQuickPick = request.kind === "quickPick";
  const isTextual =
    request.kind === "inputBox" || request.kind === "openDialog" || request.kind === "saveDialog";

  const filteredItems = useMemo(() => {
    const items = request.items ?? [];
    if (!isQuickPick || !value.trim()) return items.filter((item) => item.kind !== -1);
    const query = value.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.kind !== -1 &&
        (item.label.toLowerCase().includes(query) ||
          (request.matchOnDescription !== false && item.description?.toLowerCase().includes(query)) ||
          item.detail?.toLowerCase().includes(query))
    );
  }, [isQuickPick, request.items, request.matchOnDescription, value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filteredItems.length]);

  const respond = useCallback(
    (payload: {
      selectedIndices?: number[];
      value?: string;
      paths?: string[];
      dismissed?: boolean;
    }) => {
      if (resolvedRef.current || !socket) return;
      resolvedRef.current = true;
      if (request.interactive) {
        if (payload.dismissed) {
          socket.sendUiEvent({ requestId: request.requestId, type: "hidden" });
        } else {
          socket.sendUiEvent({
            requestId: request.requestId,
            type: "accepted",
            value: payload.value,
            selectedIndices: payload.selectedIndices,
          });
        }
      } else {
        socket.sendUiResponse({ requestId: request.requestId, ...payload });
      }
      onDone(request.requestId);
    },
    [onDone, request.interactive, request.requestId, socket]
  );

  const handleValueChange = useCallback(
    (next: string) => {
      setValue(next);
      if (request.interactive && socket) {
        socket.sendUiEvent({ requestId: request.requestId, type: "valueChanged", value: next });
      }
    },
    [request.interactive, request.requestId, socket]
  );

  const acceptCurrent = useCallback(() => {
    if (isQuickPick) {
      if (request.canSelectMany && selected.size > 0) {
        respond({ selectedIndices: [...selected] });
        return;
      }
      const item = filteredItems[activeIndex];
      if (item) {
        respond({ selectedIndices: [item.index] });
      } else {
        respond({ dismissed: true });
      }
      return;
    }
    if (request.kind === "openDialog" || request.kind === "saveDialog") {
      respond(value.trim() ? { paths: [value.trim()] } : { dismissed: true });
      return;
    }
    respond({ value });
  }, [activeIndex, filteredItems, isQuickPick, request.canSelectMany, request.kind, respond, selected, value]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        acceptCurrent();
      } else if (event.key === "ArrowDown" && isQuickPick) {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, filteredItems.length - 1));
      } else if (event.key === "ArrowUp" && isQuickPick) {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
      }
    },
    [acceptCurrent, filteredItems.length, isQuickPick]
  );

  const title =
    request.title ||
    (request.kind === "openDialog"
      ? "Select a path"
      : request.kind === "saveDialog"
        ? "Save as"
        : request.prompt || "Extension input");

  return (
    <VSCodeQuickInputShell
      open
      onClose={() => respond({ dismissed: true })}
      screenReaderTitle={title}
      inputLabel={title}
      placeholder={
        request.placeholder ?? (isTextual ? (request.prompt ?? "") : "Type to filter…")
      }
      value={value}
      onChange={handleValueChange}
      onKeyDown={onKeyDown}
    >
      <div className="max-h-[320px] overflow-y-auto">
        {request.prompt || request.title ? (
          <p className="px-[12px] pt-[8px] font-sans text-[11px] text-[var(--text-secondary)]">
            {[request.title, request.prompt].filter(Boolean).join(" — ")}
          </p>
        ) : null}
        {request.busy ? (
          <p className="flex items-center gap-[6px] px-[12px] py-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
            <Loader2 className="size-[12px] animate-spin" /> Loading…
          </p>
        ) : null}
        {isQuickPick ? (
          <ul className="flex flex-col p-[6px]">
            {filteredItems.map((item, index) => (
              <li key={`${item.index}-${item.label}`}>
                <button
                  type="button"
                  className={`flex w-full flex-col items-start gap-[1px] rounded-[4px] px-[8px] py-[5px] text-left transition-colors ${
                    index === activeIndex ? "bg-[var(--accent-bg)]" : "hover:bg-[var(--accent-bg)]"
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    if (request.canSelectMany) {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(item.index)) next.delete(item.index);
                        else next.add(item.index);
                        return next;
                      });
                      return;
                    }
                    respond({ selectedIndices: [item.index] });
                  }}
                >
                  <span className="flex w-full items-center gap-[8px]">
                    {request.canSelectMany ? (
                      <input
                        type="checkbox"
                        readOnly
                        checked={selected.has(item.index)}
                        className="size-[13px]"
                      />
                    ) : null}
                    <span className="truncate font-sans text-[13px] text-[var(--text-primary)]">
                      {item.label}
                    </span>
                    {item.description ? (
                      <span className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                  {item.detail ? (
                    <span className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {filteredItems.length === 0 && !request.busy ? (
              <li className="px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
                No matching items.
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {request.canSelectMany ? (
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[6px]">
          <button
            type="button"
            className="rounded-[4px] bg-[var(--accent)] px-[10px] py-[4px] font-sans text-[12px] text-white"
            onClick={acceptCurrent}
          >
            OK ({selected.size})
          </button>
        </div>
      ) : null}
    </VSCodeQuickInputShell>
  );
}

/* ------------------------------------------------------------------ */
/* Status bar strip                                                    */
/* ------------------------------------------------------------------ */

function ExtensionStatusBarStrip({
  workspaceId,
  items,
  progress,
}: {
  workspaceId: string;
  items: ExtensionStatusBarItem[];
  progress: Array<{ requestId: string; title?: string; message?: string }>;
}) {
  const visible = items
    .filter((item) => item.visible && item.text.trim())
    .sort((a, b) => (a.alignment === b.alignment ? b.priority - a.priority : a.alignment - b.alignment))
    .slice(0, 8);
  if (visible.length === 0 && progress.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-[8px] right-[8px] z-[900] flex max-w-[70vw] flex-wrap items-center justify-end gap-[6px]">
      {progress.map((entry) => (
        <span
          key={entry.requestId}
          className="pointer-events-auto inline-flex items-center gap-[6px] rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)] shadow-sm"
        >
          <Loader2 className="size-[11px] animate-spin" />
          <span className="max-w-[240px] truncate">
            {[entry.title, entry.message].filter(Boolean).join(": ") || "Working…"}
          </span>
        </span>
      ))}
      {visible.map((item) => {
        const { text, spinning } = stripCodicons(item.text);
        if (!text && !spinning) return null;
        return (
          <button
            key={item.itemId}
            type="button"
            title={item.tooltip || item.text}
            disabled={!item.command}
            className="pointer-events-auto inline-flex items-center gap-[5px] rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[3px] font-sans text-[11px] text-[var(--text-primary)] shadow-sm transition-colors enabled:hover:bg-[var(--accent-bg)] disabled:cursor-default"
            style={
              item.color && !item.color.startsWith("theme:") ? { color: item.color } : undefined
            }
            onClick={() => {
              if (!item.command) return;
              void executeInstalledExtensionCommand({
                workspaceId,
                command: item.command,
              }).catch(() => undefined);
            }}
          >
            {spinning ? <Loader2 className="size-[11px] animate-spin" /> : null}
            <span className="max-w-[220px] truncate">{text}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

export function ExtensionsWorkspaceBridge() {
  const { activeWorkspaceId, workspaceInfo } = useWorkspace();
  const { vscodeExtensionsBeta } = useUserPreferences();
  const editorBridgeRef = useEditorBridgeRef();
  const { openExplorerFile } = useOpenInEditor();
  const { pushNotification, dismiss } = useWorkbenchNotifications();
  const socketRef = useRef<ExtensionWorkspaceSocket | null>(null);
  const [socket, setSocket] = useState<ExtensionWorkspaceSocket | null>(null);
  const [uiRequests, setUiRequests] = useState<ExtensionUiRequest[]>([]);
  const [statusBarItems, setStatusBarItems] = useState<Map<string, ExtensionStatusBarItem>>(
    () => new Map()
  );
  const [progressItems, setProgressItems] = useState<
    Map<string, { requestId: string; title?: string; message?: string }>
  >(() => new Map());
  const notificationIdsRef = useRef(new Map<string, string>());
  const resolvedNotificationsRef = useRef(new Set<string>());
  const workspaceRootRef = useRef<string | null>(null);

  useEffect(() => {
    workspaceRootRef.current = workspaceInfo?.root ?? null;
  }, [workspaceInfo?.root]);

  const openDocument = useCallback(
    (payload: { path?: string }) => {
      const absolute = typeof payload.path === "string" ? payload.path : "";
      if (!absolute) return;
      const root = workspaceRootRef.current;
      let relative = absolute;
      if (root && (absolute === root || absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`))) {
        relative = absolute.slice(root.length).replace(/^[/\\]+/, "");
      }
      if (!relative || relative.startsWith("/")) return;
      const name = relative.split(/[/\\]/).at(-1) ?? relative;
      const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
      openExplorerFile({
        path: relative,
        name,
        language: LANGUAGE_BY_EXT[ext] ?? "plaintext",
        icon: "default",
      });
    },
    [openExplorerFile]
  );

  const showNotification = useCallback(
    (request: ExtensionUiRequest) => {
      const severity =
        request.level === "error" ? "error" : request.level === "warning" ? "warning" : "info";
      const actions = (request.items ?? []).map((item) => ({
        id: `ext-action-${request.requestId}-${item.index}`,
        label: item.label,
        primary: item.index === 0,
        onClick: () => {
          if (resolvedNotificationsRef.current.has(request.requestId)) return;
          resolvedNotificationsRef.current.add(request.requestId);
          socketRef.current?.sendUiResponse({
            requestId: request.requestId,
            actionIndex: item.index,
          });
        },
      }));
      const id = pushNotification({
        kind: "extension.notification",
        severity,
        title: request.extensionId,
        message: [request.message, request.detail].filter(Boolean).join("\n") || "(no message)",
        actions: actions.length > 0 ? actions : undefined,
        persistent: actions.length > 0,
        autoDismissMs: actions.length > 0 ? undefined : 8_000,
        compact: actions.length === 0,
        onDismiss: () => {
          notificationIdsRef.current.delete(request.requestId);
          if (actions.length === 0) return;
          if (resolvedNotificationsRef.current.has(request.requestId)) {
            resolvedNotificationsRef.current.delete(request.requestId);
            return;
          }
          resolvedNotificationsRef.current.add(request.requestId);
          socketRef.current?.sendUiResponse({ requestId: request.requestId, dismissed: true });
          resolvedNotificationsRef.current.delete(request.requestId);
        },
      });
      if (id) {
        notificationIdsRef.current.set(request.requestId, id);
      }
    },
    [pushNotification]
  );

  const handleWorkspaceEvent = useCallback(
    (event: WorkspaceExtensionEvent) => {
      const workspaceId = activeWorkspaceId;
      if (!workspaceId) return;
      const payload = event.payload as Record<string, unknown>;
      switch (event.type) {
        case "ui-request": {
          const request = payload as unknown as ExtensionUiRequest;
          if (request.kind === "notification") {
            showNotification(request);
            return;
          }
          if (request.kind === "progress") {
            setProgressItems((current) => {
              const next = new Map(current);
              next.set(request.requestId, {
                requestId: request.requestId,
                title: request.title,
              });
              return next;
            });
            return;
          }
          setUiRequests((current) =>
            current.some((existing) => existing.requestId === request.requestId)
              ? current
              : [...current, request]
          );
          return;
        }
        case "ui-update": {
          const requestId = String(payload.requestId ?? "");
          const patch = (payload.patch ?? {}) as Partial<ExtensionUiRequest>;
          setUiRequests((current) =>
            current.map((request) =>
              request.requestId === requestId ? { ...request, ...patch } : request
            )
          );
          return;
        }
        case "ui-close": {
          const requestId = String(payload.requestId ?? "");
          setUiRequests((current) => current.filter((request) => request.requestId !== requestId));
          setProgressItems((current) => {
            if (!current.has(requestId)) return current;
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          const notificationId = notificationIdsRef.current.get(requestId);
          if (notificationId) {
            resolvedNotificationsRef.current.add(requestId);
            dismiss(notificationId);
          }
          return;
        }
        case "progress": {
          const requestId = String(payload.requestId ?? "");
          if (payload.done) {
            setProgressItems((current) => {
              if (!current.has(requestId)) return current;
              const next = new Map(current);
              next.delete(requestId);
              return next;
            });
            return;
          }
          setProgressItems((current) => {
            const next = new Map(current);
            const existing = next.get(requestId);
            next.set(requestId, {
              requestId,
              title: (payload.title as string | undefined) ?? existing?.title,
              message: (payload.message as string | undefined) ?? existing?.message,
            });
            return next;
          });
          return;
        }
        case "status-bar": {
          const item = payload as unknown as ExtensionStatusBarItem;
          setStatusBarItems((current) => {
            const next = new Map(current);
            next.set(item.itemId, item);
            return next;
          });
          return;
        }
        case "status-bar-dispose": {
          const itemId = String(payload.itemId ?? "");
          setStatusBarItems((current) => {
            if (!current.has(itemId)) return current;
            const next = new Map(current);
            next.delete(itemId);
            return next;
          });
          return;
        }
        case "context": {
          setExtensionContextKey(workspaceId, String(payload.key ?? ""), payload.value);
          return;
        }
        case "open-document": {
          openDocument(payload as { path?: string });
          return;
        }
        case "external-url": {
          const url = typeof payload.url === "string" ? payload.url : "";
          if (!url) return;
          try {
            const parsed = new URL(url);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") {
              void editorBridgeRef.current?.openBrowserTab(parsed.href, {
                activate: true,
                engine: "proxy",
              });
            }
          } catch {
            /* invalid URL */
          }
          return;
        }
        case "clipboard-write": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text && typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(text).catch(() => undefined);
          }
          return;
        }
        case "editor-edit": {
          applyExtensionTextEdits({
            path: String(payload.path ?? ""),
            edits: Array.isArray(payload.edits)
              ? (payload.edits as Array<{
                  startLine: number;
                  startColumn: number;
                  endLine: number;
                  endColumn: number;
                  newText: string;
                }>)
              : [],
          });
          return;
        }
        case "diagnostics": {
          applyExtensionDiagnostics({
            owner: `${String(payload.extensionId ?? "")}:${String(payload.collection ?? "")}`,
            uri: String(payload.uri ?? ""),
            entries: Array.isArray(payload.entries)
              ? (payload.entries as ExtensionDiagnosticEntry[])
              : [],
          });
          return;
        }
        case "diagnostics-clear": {
          clearExtensionDiagnostics(
            `${String(payload.extensionId ?? "")}:${String(payload.collection ?? "")}`
          );
          return;
        }
        case "panel-opened": {
          const sessionId = String(payload.sessionId ?? "");
          if (!sessionId) return;
          editorBridgeRef.current?.openExtensionSurfaceTab({
            extensionId: String(payload.extensionId ?? ""),
            surfaceId: String(payload.surfaceId ?? ""),
            title: String(payload.title ?? "Extension"),
            surfaceKind: "webview",
            surfaceSessionId: sessionId,
            placement: "editor",
          });
          return;
        }
        case "host-crashed": {
          pushNotification({
            kind: "extension.host",
            severity: "error",
            title: "Extension host",
            message: "The extension host crashed. Restarting automatically…",
            autoDismissMs: 6_000,
            compact: true,
          });
          return;
        }
        case "host-restarted": {
          pushNotification({
            kind: "extension.host",
            severity: "info",
            title: "Extension host",
            message: "Extension host recovered; surfaces were restored.",
            autoDismissMs: 5_000,
            compact: true,
          });
          return;
        }
        default:
          return;
      }
    },
    [activeWorkspaceId, dismiss, editorBridgeRef, openDocument, pushNotification, showNotification]
  );

  const handleWorkspaceEventRef = useRef(handleWorkspaceEvent);
  useEffect(() => {
    handleWorkspaceEventRef.current = handleWorkspaceEvent;
  }, [handleWorkspaceEvent]);

  const seedFromSnapshot = useCallback(async (workspaceId: string) => {
    try {
      const snapshot = await fetchWorkspaceExtensionUiState(workspaceId);
      setStatusBarItems(new Map(snapshot.statusBarItems.map((item) => [item.itemId, item])));
      replaceExtensionContextKeys(workspaceId, snapshot.contextKeys);
      setUiRequests(
        snapshot.uiRequests.filter(
          (request) => request.kind !== "notification" && request.kind !== "progress"
        )
      );
      for (const entry of snapshot.diagnostics) {
        applyExtensionDiagnostics({ owner: entry.key, uri: entry.uri, entries: entry.entries });
      }
    } catch {
      /* server may not have extension state yet */
    }
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId || !vscodeExtensionsBeta) {
      return;
    }
    const acquired = acquireExtensionSocket(activeWorkspaceId);
    socketRef.current = acquired;
    setSocket(acquired);
    const unsubscribeEvents = acquired.subscribeWorkspace((event) =>
      handleWorkspaceEventRef.current(event)
    );
    const unsubscribeResync = acquired.subscribeResync(() => {
      void seedFromSnapshot(activeWorkspaceId);
    });
    void seedFromSnapshot(activeWorkspaceId);
    return () => {
      unsubscribeEvents();
      unsubscribeResync();
      socketRef.current = null;
      setSocket(null);
      setUiRequests([]);
      setStatusBarItems(new Map());
      setProgressItems(new Map());
      releaseExtensionSocket(acquired);
    };
  }, [activeWorkspaceId, seedFromSnapshot, vscodeExtensionsBeta]);

  const activeQuickInput = uiRequests[0] ?? null;

  if (!vscodeExtensionsBeta || !activeWorkspaceId) {
    return null;
  }

  return (
    <>
      {activeQuickInput ? (
        <ExtensionQuickInputOverlay
          key={activeQuickInput.requestId}
          request={activeQuickInput}
          socket={socket}
          onDone={(requestId) =>
            setUiRequests((current) => current.filter((request) => request.requestId !== requestId))
          }
        />
      ) : null}
      <ExtensionStatusBarStrip
        workspaceId={activeWorkspaceId}
        items={[...statusBarItems.values()]}
        progress={[...progressItems.values()]}
      />
    </>
  );
}
