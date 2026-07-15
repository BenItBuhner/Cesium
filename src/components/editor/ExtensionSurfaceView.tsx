"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { MarketplaceSurface } from "@/components/editor/MarketplaceSurface";
import { DEFAULT_WEBVIEW_HTML, WebviewIframe } from "@/components/editor/WebviewIframe";
import {
  attachExtensionSurfaceSessionClient,
  createExtensionSurfaceSession,
  deliverExtensionSurfaceSessionMessageClient,
  detachExtensionSurfaceSessionClient,
  readExtensionSurfaceEvents,
  updateExtensionSurfaceStateClient,
  updateExtensionSurfaceThemeClient,
  type ExtensionSurfaceEvent,
  type ExtensionSurfaceSession,
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

function wrapWebviewHtml(input: {
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
  const apiShim = `<script${nonceAttr}>(function(){var state=${stateJson};function send(payload){try{window.parent&&window.parent.postMessage(payload,"*")}catch(error){console.warn("[opencursor-webview] bridge send failed",error)}}window.acquireVsCodeApi=window.acquireVsCodeApi||function(){return{postMessage:function(message){send({type:"opencursor-extension-webview-message",message:message});setTimeout(function(){send({type:"opencursor-extension-webview-message-retry",message:message});},50);},getState:function(){return state},setState:function(next){state=next;send({type:"opencursor-extension-webview-state",state:state});return state}}};})();</script>`;
  const errorShim = `<script${nonceAttr}>(function(){window.addEventListener("unhandledrejection",function(event){var reason=event&&event.reason;var message=reason&&reason.message?String(reason.message):String(reason||"");if(message==="Failed to fetch"||message.indexOf("Failed to fetch")>=0){console.warn("[opencursor-webview] swallowed extension fetch rejection",reason);event.preventDefault();}});window.addEventListener("error",function(event){var message=event&&event.message?String(event.message):"";if(message.indexOf("Failed to fetch")>=0){console.warn("[opencursor-webview] swallowed extension fetch error",message);event.preventDefault();}});})();</script>`;
  const externalShim = `<script${nonceAttr}>(function(){function openExternal(url){if(!url)return;window.parent&&window.parent.postMessage({type:"opencursor-extension-open-external",url:String(url)},"*")}window.open=function(url){openExternal(url);return null};document.addEventListener("click",function(event){var target=event.target&&event.target.closest?event.target.closest("a[href]"):null;if(!target)return;var href=target.href;if(!href)return;event.preventDefault();openExternal(href)},true);})();</script>`;
  const messageShim = `<script${nonceAttr}>(function(){window.__opencursorReplayWebviewMessages=function(messages){if(!Array.isArray(messages)||!messages.length)return;messages.forEach(function(message){window.dispatchEvent(new MessageEvent("message",{data:message}));});};window.addEventListener("message",function(event){var data=event.data;if(data&&data.type==="opencursor-extension-replay-messages"){window.__opencursorReplayWebviewMessages(data.messages);}});})();</script>`;
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
  return withMessages.replace(
    /<head([^>]*)>/i,
    `<head$1><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http://localhost:9100 data:; style-src 'unsafe-inline' http://localhost:9100; script-src 'unsafe-inline' http://localhost:9100;">`
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
    const size = JSON.stringify(message).length;
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
  const deliveredMessageSeqRef = useRef(0);
  const latestVscodeStateRef = useRef<unknown>(null);
  const themeRef = useRef<ExtensionWebviewThemeSnapshot | null>(null);
  const sessionRef = useRef<ExtensionSurfaceSession | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const loadingRetryRef = useRef(0);
  const eventCursorRef = useRef(0);
  const [session, setSession] = useState<ExtensionSurfaceSession | null>(null);
  const [html, setHtml] = useState(surface.html ?? "");
  const [messages, setMessages] = useState<Array<{ seq: number; ts: number; message: unknown }>>([]);
  const [frameDoc, setFrameDoc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialMessages = useMemo(() => boundedInitialMessages(messages), [messages]);
  const theme = useMemo(() => buildVscodeWebviewTheme(themeConfig), [themeConfig]);
  const surfaceKey = `${surface.extensionId}:${surface.surfaceId}:${surface.surfaceSessionId ?? ""}:${placement}`;

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

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

  useEffect(() => {
    if (!activeWorkspaceId || surface.kind === "marketplace" || surface.kind === "output") return;
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
      includeMessages: false,
    })
      .then(async (snapshot) => {
        if (cancelled) return;
        sessionRef.current = snapshot.session;
        activeWorkspaceIdRef.current = activeWorkspaceId;
        setSession(snapshot.session);
        setHtml(snapshot.html);
        setMessages(snapshot.messages);
        deliveredMessageSeqRef.current = snapshot.messages.at(-1)?.seq ?? 0;
        latestVscodeStateRef.current = snapshot.vscodeState ?? null;
        setFrameDoc(
          wrapWebviewHtml({
            html: snapshot.html || DEFAULT_WEBVIEW_HTML,
            theme: initialTheme,
            vscodeState: latestVscodeStateRef.current,
          })
        );
        eventCursorRef.current = 0;
        for (const url of snapshot.externalUrls) openExternalInInternalBrowser(url);
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
  }, [
    activeWorkspaceId,
    clientId,
    openExternalInInternalBrowser,
    placement,
    surface.extensionId,
    surface.kind,
    surface.surfaceId,
    surface.surfaceSessionId,
    surface.title,
    surface.viewType,
    surfaceKey,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !loading || html || surface.kind === "marketplace" || surface.kind === "output") {
      return;
    }
    const retry = loadingRetryRef.current + 1;
    loadingRetryRef.current = retry;
    const timer = window.setTimeout(() => {
      const currentTheme = themeRef.current ?? theme;
      void createExtensionSurfaceSession({
        workspaceId: activeWorkspaceId,
        extensionId: surface.extensionId,
        surfaceId: surface.surfaceId,
        title: surface.title,
        kind: surface.kind,
        viewType: surface.viewType,
        placement,
        sessionId: surface.surfaceSessionId,
        theme: currentTheme,
        includeMessages: false,
      })
        .then((snapshot) => {
          if (loadingRetryRef.current !== retry) return;
          sessionRef.current = snapshot.session;
          setSession(snapshot.session);
          setHtml(snapshot.html);
          setMessages(snapshot.messages);
          deliveredMessageSeqRef.current = snapshot.messages.at(-1)?.seq ?? 0;
          latestVscodeStateRef.current = snapshot.vscodeState ?? null;
          setFrameDoc(
            wrapWebviewHtml({
              html: snapshot.html || DEFAULT_WEBVIEW_HTML,
              theme: currentTheme,
              vscodeState: latestVscodeStateRef.current,
            })
          );
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
  }, [activeWorkspaceId, html, loading, placement, surface, theme]);

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

  useEffect(() => {
    if (!activeWorkspaceId || !session) return;
    void updateExtensionSurfaceThemeClient({
      workspaceId: activeWorkspaceId,
      sessionId: session.sessionId,
      theme,
    }).catch(() => undefined);
    iframeRef.current?.contentWindow?.postMessage({ type: "opencursor-extension-theme", theme }, "*");
  }, [activeWorkspaceId, session, theme]);

  const handleSurfaceEvent = useCallback(
    (event: ExtensionSurfaceEvent) => {
      if (event.type === "message") {
        const message = (event.payload as { message?: unknown } | undefined)?.message;
        iframeRef.current?.contentWindow?.postMessage(message, "*");
      }
      if (event.type === "theme") {
        iframeRef.current?.contentWindow?.postMessage({ type: "opencursor-extension-theme", theme: event.payload }, "*");
      }
      if (event.type === "external-url") {
        openExternalInInternalBrowser((event.payload as { url?: unknown } | undefined)?.url);
      }
    },
    [openExternalInInternalBrowser]
  );

  useEffect(() => {
    if (!activeWorkspaceId || !session) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void readExtensionSurfaceEvents({
        workspaceId: activeWorkspaceId,
        sessionId: session.sessionId,
        cursor: eventCursorRef.current,
      }).then((result) => {
        if (cancelled) return;
        eventCursorRef.current = result.cursor;
        for (const event of result.events) {
          handleSurfaceEvent(event);
        }
      }).catch(() => undefined);
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, handleSurfaceEvent, session]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const currentWorkspaceId = activeWorkspaceIdRef.current;
      const currentSession = sessionRef.current;
      if (!currentWorkspaceId || !currentSession) return;
      const data = event.data as {
        type?: unknown;
        message?: unknown;
        state?: unknown;
        url?: unknown;
      } | null;
      if (!data) return;
      if (data.type === "opencursor-extension-open-external") {
        openExternalInInternalBrowser(data.url);
        return;
      }
      if (data.type === "opencursor-extension-webview-state") {
        latestVscodeStateRef.current = data.state;
        void updateExtensionSurfaceStateClient({
          workspaceId: currentWorkspaceId,
          sessionId: currentSession.sessionId,
          state: data.state,
        }).catch(() => undefined);
        return;
      }
      if (
        data.type !== "opencursor-extension-webview-message" &&
        data.type !== "opencursor-extension-webview-message-retry"
      ) return;
      void deliverExtensionSurfaceSessionMessageClient({
        workspaceId: currentWorkspaceId,
        sessionId: currentSession.sessionId,
        message: data.message,
      }).then((snapshot) => {
        setMessages(snapshot.messages);
        for (const entry of snapshot.messages.filter((candidate) => candidate.seq > deliveredMessageSeqRef.current)) {
          iframeRef.current?.contentWindow?.postMessage(entry.message, "*");
          deliveredMessageSeqRef.current = Math.max(deliveredMessageSeqRef.current, entry.seq);
        }
        for (const url of snapshot.externalUrls) openExternalInInternalBrowser(url);
      }).catch(() => {
        // Extension webviews can continue posting during server restarts or after
        // a retained session is closed. Treat bridge delivery failures as dropped
        // messages instead of surfacing a global Next.js runtime overlay.
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openExternalInInternalBrowser]);

  useEffect(() => {
    if (!initialMessages.length) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const payload = { type: "opencursor-extension-replay-messages", messages: initialMessages };
    const post = () => win.postMessage(payload, "*");
    post();
    const timers = [100, 500, 1500, 3000, 6000].map((delay) =>
      window.setTimeout(post, delay)
    );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [initialMessages, html]);

  if (surface.kind === "marketplace") {
    return <MarketplaceSurface />;
  }

  if (loading && !html) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-main)] font-sans text-[12px] text-[var(--text-secondary)]">
        Loading {surface.title}...
      </div>
    );
  }

  if (error && !html) {
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
      <WebviewIframe iframeRef={iframeRef} title={surface.title} frameDoc={frameDoc} />
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
