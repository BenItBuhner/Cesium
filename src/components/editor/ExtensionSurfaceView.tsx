"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink, WifiOff } from "lucide-react";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { MarketplaceSurface } from "@/components/editor/MarketplaceSurface";
import { DEFAULT_WEBVIEW_HTML, WebviewIframe } from "@/components/editor/WebviewIframe";
import { ExtensionTreeView } from "@/components/extensions/ExtensionTreeView";
import {
  acquireExtensionSocket,
  releaseExtensionSocket,
  type ExtensionSocketStatus,
  type ExtensionWorkspaceSocket,
} from "@/lib/extensions/extension-socket";
import {
  attachExtensionSurfaceSessionClient,
  createExtensionSurfaceSession,
  detachExtensionSurfaceSessionClient,
  getServerBaseUrl,
  type ExtensionSurfaceEvent,
  type ExtensionSurfaceSession,
  type ExtensionTreeItem,
  type ExtensionWebviewThemeSnapshot,
} from "@/lib/server-api";
import type { EditorTab } from "@/lib/types";
import { buildVscodeWebviewTheme } from "@/lib/vscode-webview-theme";

const INITIAL_WEBVIEW_MESSAGE_LIMIT = 300;
const INITIAL_WEBVIEW_MESSAGE_BYTES = 16 * 1024 * 1024;

type SurfaceMetadata = NonNullable<EditorTab["extensionSurface"]>;

function styleFromTheme(theme: ExtensionWebviewThemeSnapshot): string {
  const variables = Object.entries(theme.variables)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
  return `<style data-opencursor-webview-theme>:root{color-scheme:${theme.colorScheme};${variables}}html,body,#root{min-height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);}</style>`;
}

function themeScript(theme: ExtensionWebviewThemeSnapshot, nonceAttr = ""): string {
  const themeJson = JSON.stringify(theme).replace(/</g, "\\u003c");
  return `<script${nonceAttr}>(function(){function applyTheme(theme){if(!theme||!theme.variables)return;var root=document.documentElement;root.style.colorScheme=theme.colorScheme||"dark";Object.keys(theme.variables).forEach(function(key){root.style.setProperty(key,String(theme.variables[key]));});}window.__opencursorApplyWebviewTheme=applyTheme;window.addEventListener("message",function(event){var data=event.data;if(data&&data.type==="opencursor-extension-theme")applyTheme(data.theme);});applyTheme(${themeJson});})();</script>`;
}

export function wrapWebviewHtml(input: {
  html: string;
  theme: ExtensionWebviewThemeSnapshot;
  vscodeState: unknown;
}): string {
  const html = input.html || DEFAULT_WEBVIEW_HTML;
  const nonce =
    html.match(/\bnonce=["']([^"']+)["']/i)?.[1] ??
    html.match(/script-src[^"']*'nonce-([^'\s;]+)/i)?.[1] ??
    "";
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  const stateJson = JSON.stringify(input.vscodeState ?? null).replace(/</g, "\\u003c");
  const apiShim = `<script${nonceAttr}>(function(){var state=${stateJson};function send(payload){try{window.parent&&window.parent.postMessage(payload,"*")}catch(error){console.warn("[opencursor-webview] bridge send failed",error)}}window.acquireVsCodeApi=window.acquireVsCodeApi||function(){return{postMessage:function(message){send({type:"opencursor-extension-webview-message",message:message});},getState:function(){return state},setState:function(next){state=next;send({type:"opencursor-extension-webview-state",state:state});return state}}};})();</script>`;
  const errorShim = `<script${nonceAttr}>(function(){window.addEventListener("unhandledrejection",function(event){var reason=event&&event.reason;var message=reason&&reason.message?String(reason.message):String(reason||"");if(message==="Failed to fetch"||message.indexOf("Failed to fetch")>=0){console.warn("[opencursor-webview] swallowed extension fetch rejection",reason);event.preventDefault();}});window.addEventListener("error",function(event){var message=event&&event.message?String(event.message):"";if(message.indexOf("Failed to fetch")>=0){console.warn("[opencursor-webview] swallowed extension fetch error",message);event.preventDefault();}});})();</script>`;
  const externalShim = `<script${nonceAttr}>(function(){function openExternal(url){if(!url)return;window.parent&&window.parent.postMessage({type:"opencursor-extension-open-external",url:String(url)},"*")}window.open=function(url){openExternal(url);return null};document.addEventListener("click",function(event){var target=event.target&&event.target.closest?event.target.closest("a[href]"):null;if(!target)return;var href=target.href;if(!href)return;if(href.indexOf("#")===0||(target.getAttribute("href")||"").indexOf("#")===0)return;event.preventDefault();openExternal(href)},true);})();</script>`;
  // Ready handshake: the parent buffers extension messages until the frame
  // signals it can receive them, then replays exactly once. This replaces the
  // old fire-and-hope timers and removes duplicate/lost replay races.
  const messageShim = `<script${nonceAttr}>(function(){window.__opencursorReplayWebviewMessages=function(messages){if(!Array.isArray(messages)||!messages.length)return;messages.forEach(function(message){window.dispatchEvent(new MessageEvent("message",{data:message}));});};window.addEventListener("message",function(event){var data=event.data;if(data&&data.type==="opencursor-extension-replay-messages"){window.__opencursorReplayWebviewMessages(data.messages);}});try{window.parent&&window.parent.postMessage({type:"opencursor-extension-webview-ready"},"*");}catch(e){}})();</script>`;
  const themed = /<head([^>]*)>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${styleFromTheme(input.theme)}${themeScript(input.theme, nonceAttr)}${apiShim}`)
    : `${styleFromTheme(input.theme)}${themeScript(input.theme, nonceAttr)}${apiShim}${html}`;
  const withApi = /<body([^>]*)>/i.test(themed)
    ? themed.replace(/<body([^>]*)>/i, `<body$1>${errorShim}${externalShim}`)
    : `${errorShim}${externalShim}${themed}`;
  const withMessages = /<\/body>/i.test(withApi)
    ? withApi.replace(/<\/body>/i, `${messageShim}</body>`)
    : `${withApi}${messageShim}`;
  if (/Content-Security-Policy/i.test(withMessages)) {
    return withMessages;
  }
  const serverOrigin = getServerBaseUrl() || "";
  return withMessages.replace(
    /<head([^>]*)>/i,
    `<head$1><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: blob: ${serverOrigin}; style-src 'unsafe-inline' https: http: ${serverOrigin}; font-src https: http: data: ${serverOrigin}; connect-src https: http: ws: wss: data: ${serverOrigin}; media-src https: http: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https: http: ${serverOrigin};">`
  );
}

function boundedInitialMessages(
  messages: Array<{ seq: number; ts: number; message: unknown }>
): unknown[] {
  const selected: unknown[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= INITIAL_WEBVIEW_MESSAGE_LIMIT) break;
    const message = messages[index]?.message;
    let size = 0;
    try {
      size = JSON.stringify(message).length;
    } catch {
      continue;
    }
    if (size > INITIAL_WEBVIEW_MESSAGE_BYTES) {
      continue;
    }
    if (selected.length > 0 && bytes + size > INITIAL_WEBVIEW_MESSAGE_BYTES) {
      break;
    }
    bytes += size;
    selected.unshift(message);
  }
  return selected;
}

export function ExtensionSurfaceFrame({
  surface,
  placement = "editor",
  showPopOut = false,
  onPopOut,
}: {
  surface: SurfaceMetadata;
  placement?: "sidebar" | "editor";
  showPopOut?: boolean;
  onPopOut?: (session: ExtensionSurfaceSession | null) => void;
}) {
  const { activeWorkspaceId } = useWorkspace();
  const { themeConfig } = useTheme();
  const editorBridgeRef = useEditorBridgeRef();
  const clientId = useId().replace(/:/g, "_");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameReadyRef = useRef(false);
  const queuedFrameMessagesRef = useRef<unknown[]>([]);
  const deliveredMessageSeqRef = useRef(0);
  const latestVscodeStateRef = useRef<unknown>(null);
  const themeRef = useRef<ExtensionWebviewThemeSnapshot | null>(null);
  const sessionRef = useRef<ExtensionSurfaceSession | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const loadingRetryRef = useRef(0);
  const messagesRef = useRef<Array<{ seq: number; ts: number; message: unknown }>>([]);
  const socketRef = useRef<ExtensionWorkspaceSocket | null>(null);
  const htmlVersionRef = useRef(0);
  const [session, setSession] = useState<ExtensionSurfaceSession | null>(null);
  const [html, setHtml] = useState(surface.html ?? "");
  const [frameDoc, setFrameDoc] = useState("");
  const [treeItems, setTreeItems] = useState<ExtensionTreeItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<ExtensionSocketStatus>("connecting");
  const theme = useMemo(() => buildVscodeWebviewTheme(themeConfig), [themeConfig]);
  const surfaceKey = `${surface.extensionId}:${surface.surfaceId}:${surface.surfaceSessionId ?? ""}:${placement}`;
  const isPassiveKind = surface.kind === "marketplace" || surface.kind === "output";

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Shared workspace socket (ref-counted).
  useEffect(() => {
    if (!activeWorkspaceId || isPassiveKind) return;
    const socket = acquireExtensionSocket(activeWorkspaceId);
    socketRef.current = socket;
    const unsubscribe = socket.subscribeStatus(setSocketStatus);
    return () => {
      unsubscribe();
      socketRef.current = null;
      releaseExtensionSocket(socket);
    };
  }, [activeWorkspaceId, isPassiveKind]);

  const openExternalInInternalBrowser = useCallback(
    (rawUrl: unknown) => {
      if (typeof rawUrl !== "string" || !rawUrl.trim()) return;
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      void editorBridgeRef.current?.openBrowserTab(parsed.href, {
        activate: true,
        engine: "proxy",
      });
    },
    [editorBridgeRef]
  );

  const postToFrame = useCallback((message: unknown) => {
    if (!frameReadyRef.current) {
      queuedFrameMessagesRef.current.push(message);
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const rebuildFrameDoc = useCallback(
    (nextHtml: string) => {
      frameReadyRef.current = false;
      queuedFrameMessagesRef.current = [];
      setFrameDoc(
        wrapWebviewHtml({
          html: nextHtml || DEFAULT_WEBVIEW_HTML,
          theme: themeRef.current ?? theme,
          vscodeState: latestVscodeStateRef.current,
        })
      );
    },
    [theme]
  );

  const applySnapshot = useCallback(
    (snapshot: {
      session: ExtensionSurfaceSession;
      html: string;
      htmlVersion: number;
      messages: Array<{ seq: number; ts: number; message: unknown }>;
      externalUrls: string[];
      vscodeState?: unknown;
      isTree?: boolean;
      treeItems?: ExtensionTreeItem[];
    }) => {
      sessionRef.current = snapshot.session;
      setSession(snapshot.session);
      messagesRef.current = snapshot.messages;
      latestVscodeStateRef.current = snapshot.vscodeState ?? null;
      htmlVersionRef.current = snapshot.htmlVersion;
      if (snapshot.isTree) {
        setTreeItems(snapshot.treeItems ?? []);
        setHtml("");
      } else {
        setTreeItems(null);
        setHtml(snapshot.html);
        rebuildFrameDoc(snapshot.html);
      }
      for (const url of snapshot.externalUrls) openExternalInInternalBrowser(url);
    },
    [openExternalInInternalBrowser, rebuildFrameDoc]
  );

  useEffect(() => {
    if (!activeWorkspaceId || isPassiveKind) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const initialTheme = themeRef.current ?? theme;
    createExtensionSurfaceSession({
      workspaceId: activeWorkspaceId,
      extensionId: surface.extensionId,
      surfaceId: surface.surfaceId,
      title: surface.title,
      kind: surface.kind,
      viewType: surface.viewType,
      placement,
      sessionId: surface.surfaceSessionId,
      theme: initialTheme,
      includeMessages: true,
    })
      .then(async (snapshot) => {
        if (cancelled) return;
        activeWorkspaceIdRef.current = activeWorkspaceId;
        applySnapshot(snapshot);
        await attachExtensionSurfaceSessionClient({
          workspaceId: activeWorkspaceId,
          sessionId: snapshot.session.sessionId,
          clientId,
          theme: initialTheme,
        }).catch(() => undefined);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, clientId, placement, surfaceKey]);

  // Slow-resolve retry: if the surface stays empty, ask again once.
  useEffect(() => {
    if (!activeWorkspaceId || !loading || html || treeItems || isPassiveKind) {
      return;
    }
    const retry = loadingRetryRef.current + 1;
    loadingRetryRef.current = retry;
    const timer = window.setTimeout(() => {
      void createExtensionSurfaceSession({
        workspaceId: activeWorkspaceId,
        extensionId: surface.extensionId,
        surfaceId: surface.surfaceId,
        title: surface.title,
        kind: surface.kind,
        viewType: surface.viewType,
        placement,
        sessionId: surface.surfaceSessionId,
        theme: themeRef.current ?? theme,
        includeMessages: true,
      })
        .then((snapshot) => {
          if (loadingRetryRef.current !== retry) return;
          applySnapshot(snapshot);
          setLoading(false);
          setError(null);
        })
        .catch((err) => {
          if (loadingRetryRef.current !== retry) return;
          setLoading(false);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 8_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, html, treeItems, loading, placement, surfaceKey, theme]);

  useEffect(() => {
    if (!activeWorkspaceId || !session) return;
    return () => {
      void detachExtensionSurfaceSessionClient({
        workspaceId: activeWorkspaceId,
        sessionId: session.sessionId,
        clientId,
      });
    };
  }, [activeWorkspaceId, clientId, session]);

  // Theme propagation: workspace-wide over the socket + local iframe update.
  useEffect(() => {
    if (!session) return;
    socketRef.current?.sendTheme(theme);
    postToFrame({ type: "opencursor-extension-theme", theme });
  }, [postToFrame, session, theme]);

  const handleSurfaceEvent = useCallback(
    (event: ExtensionSurfaceEvent) => {
      if (event.type === "message") {
        const payload = event.payload as { seq?: number; message?: unknown } | undefined;
        const seq = typeof payload?.seq === "number" ? payload.seq : null;
        if (seq !== null && seq <= deliveredMessageSeqRef.current) return;
        if (seq !== null) {
          deliveredMessageSeqRef.current = seq;
          messagesRef.current = [...messagesRef.current.slice(-299), { seq, ts: event.ts, message: payload?.message }];
        }
        postToFrame(payload?.message);
        return;
      }
      if (event.type === "html") {
        const payload = event.payload as
          | { htmlVersion?: number; html?: string; isTree?: boolean }
          | undefined;
        if (typeof payload?.htmlVersion === "number" && payload.htmlVersion <= htmlVersionRef.current) {
          return;
        }
        htmlVersionRef.current = payload?.htmlVersion ?? htmlVersionRef.current + 1;
        if (typeof payload?.html === "string") {
          setHtml(payload.html);
          if (!payload.isTree) {
            setTreeItems(null);
            rebuildFrameDoc(payload.html);
          }
        }
        return;
      }
      if (event.type === "theme") {
        postToFrame({ type: "opencursor-extension-theme", theme: event.payload });
        return;
      }
      if (event.type === "external-url") {
        openExternalInInternalBrowser((event.payload as { url?: unknown } | undefined)?.url);
        return;
      }
      if (event.type === "state") {
        latestVscodeStateRef.current = (event.payload as { state?: unknown } | undefined)?.state ?? null;
      }
    },
    [openExternalInInternalBrowser, postToFrame, rebuildFrameDoc]
  );

  // Realtime events over the shared socket (with polling fallback inside).
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !session) return;
    return socket.subscribeSession(session.sessionId, handleSurfaceEvent);
  }, [handleSurfaceEvent, session]);

  // Bridge: iframe -> parent messages.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const currentWorkspaceId = activeWorkspaceIdRef.current;
      const currentSession = sessionRef.current;
      const data = event.data as {
        type?: unknown;
        message?: unknown;
        state?: unknown;
        url?: unknown;
      } | null;
      if (!data) return;
      if (data.type === "opencursor-extension-webview-ready") {
        frameReadyRef.current = true;
        const initial = boundedInitialMessages(messagesRef.current);
        const queued = queuedFrameMessagesRef.current.splice(0);
        const replay = [...initial, ...queued];
        if (replay.length > 0) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "opencursor-extension-replay-messages", messages: replay },
            "*"
          );
        }
        const currentSeq = messagesRef.current.at(-1)?.seq ?? 0;
        deliveredMessageSeqRef.current = Math.max(deliveredMessageSeqRef.current, currentSeq);
        return;
      }
      if (!currentWorkspaceId || !currentSession) return;
      if (data.type === "opencursor-extension-open-external") {
        openExternalInInternalBrowser(data.url);
        return;
      }
      if (data.type === "opencursor-extension-webview-state") {
        latestVscodeStateRef.current = data.state;
        socketRef.current?.sendState(currentSession.sessionId, data.state);
        return;
      }
      if (data.type !== "opencursor-extension-webview-message") return;
      const socket = socketRef.current;
      if (!socket) return;
      void socket
        .deliverWebviewMessage(currentSession.sessionId, data.message)
        .then((result) => {
          if (result.missingWebview) {
            // Host likely restarted; the server re-resolves surfaces on
            // restart, so retry once after a short delay.
            setTimeout(() => {
              void socket.deliverWebviewMessage(currentSession.sessionId, data.message);
            }, 750);
          }
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openExternalInInternalBrowser]);

  if (surface.kind === "marketplace") {
    return <MarketplaceSurface />;
  }

  if (loading && !html && !treeItems) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-main)] font-sans text-[12px] text-[var(--text-secondary)]">
        Loading {surface.title}...
      </div>
    );
  }

  if (error && !html && !treeItems) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-main)] px-[16px] text-center font-sans text-[12px] text-[var(--text-secondary)]">
        {error}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 bg-[var(--bg-main)]">
      {showPopOut ? (
        <button
          type="button"
          title="Open in editor"
          className="absolute right-[8px] top-[8px] z-10 inline-flex h-[26px] w-[26px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] shadow-sm transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          onClick={() => onPopOut?.(session)}
        >
          <ExternalLink size={13} />
        </button>
      ) : null}
      {socketStatus === "polling" ? (
        <div
          title="Realtime connection lost — running on polling fallback"
          className="absolute left-[8px] top-[8px] z-10 inline-flex items-center gap-[4px] rounded-[4px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[6px] py-[2px] font-sans text-[10px] text-[var(--warning,#fbbf24)]"
        >
          <WifiOff size={10} />
          fallback
        </div>
      ) : null}
      {treeItems !== null && activeWorkspaceId ? (
        <ExtensionTreeView
          workspaceId={activeWorkspaceId}
          extensionId={surface.extensionId}
          viewId={surface.surfaceId}
          socket={socketRef.current}
          initialItems={treeItems}
        />
      ) : (
        <WebviewIframe iframeRef={iframeRef} title={surface.title} frameDoc={frameDoc} />
      )}
    </div>
  );
}

export function ExtensionSurfaceView({ tab }: { tab: EditorTab }) {
  const surface = tab.extensionSurface;
  if (!surface) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-main)] font-sans text-[12px] text-[var(--text-secondary)]">
        Missing extension surface metadata.
      </div>
    );
  }
  return <ExtensionSurfaceFrame surface={surface} placement={surface.placement ?? "editor"} />;
}
