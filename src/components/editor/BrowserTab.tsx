"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pen, RefreshCw, SquareTerminal } from "lucide-react";
import {
  buildBrowserProxyUrl,
  normalizeBrowserTargetUrl,
} from "@/lib/browser-proxy-url";
import { resolveFaviconForPage } from "@/lib/browser-favicon";
import { buildIframeAuthenticatedUrl } from "@/lib/auth-client";
import {
  captureRenderedBrowserElementScreenshot,
  createBrowserDebugSession,
  deleteBrowserDebugSession,
  getBrowserDebugSession,
  getServerBaseUrl,
  navigateBrowserDebugSession,
} from "@/lib/server-api";
import type { EditorTab } from "@/lib/types";
import type {
  EditorGroup,
  EditorPanelAction,
} from "@/components/editor/editor-panel-state";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";

const DEFAULT_HOME = "http://localhost:3000/";

type HistoryStack = { entries: string[]; index: number };

function isDesignGuestMessage(data: unknown): data is {
  source: string;
  kind: string;
  label?: string;
  snippet?: string;
  imageDataUrl?: string;
  caption?: string;
  enabled?: boolean;
  captureId?: string;
  pageUrl?: string;
  pathIndices?: number[];
  rect?: { left: number; top: number; width: number; height: number } | null;
  viewport?: { width: number; height: number } | null;
  scroll?: { x: number; y: number } | null;
} {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.source === "opencursor-design-guest" && typeof d.kind === "string";
}

export function BrowserTab({
  tab,
  dispatch,
  editorGroup,
}: {
  tab: EditorTab;
  dispatch: (action: EditorPanelAction) => void;
  editorGroup: EditorGroup;
}) {
  const { applyBrowserDesignCapture, attachImageToBrowserDesignCapture } = useOpenInEditor();
  const { activeWorkspaceId } = useWorkspace();
  const { pushNotification } = useWorkbenchNotifications();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const debugSessionIdRef = useRef<string | null>(null);
  const processedCaptureIdsRef = useRef<string[]>([]);
  const [consoleError, setConsoleError] = useState<string | null>(null);

  const captureRenderedFallback = useCallback(
    async (payload: {
      pageUrl?: string;
      pathIndices?: number[];
      rect?: { left: number; top: number; width: number; height: number } | null;
      viewport?: { width: number; height: number } | null;
      scroll?: { x: number; y: number } | null;
    }): Promise<string | null> => {
      if (!payload.pageUrl) {
        return null;
      }
      try {
        return await captureRenderedBrowserElementScreenshot({
          pageUrl: payload.pageUrl,
          pathIndices: payload.pathIndices ?? [],
          rect: payload.rect ?? null,
          viewport: payload.viewport ?? null,
          scroll: payload.scroll ?? null,
        });
      } catch {
        return null;
      }
    },
    []
  );

  const composeAnnotationOverlay = useCallback(
    async (baseDataUrl: string, overlayDataUrl: string): Promise<string | null> => {
      try {
        const load = (src: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("image load failed"));
            img.src = src;
          });
        const [baseImg, overlayImg] = await Promise.all([load(baseDataUrl), load(overlayDataUrl)]);
        const w = Math.max(1, baseImg.naturalWidth || baseImg.width);
        const h = Math.max(1, baseImg.naturalHeight || baseImg.height);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(baseImg, 0, 0, w, h);
        ctx.drawImage(overlayImg, 0, 0, w, h);
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    },
    []
  );

  useEffect(() => {
    debugSessionIdRef.current = tab.browser?.debugSessionId ?? null;
  }, [tab.browser?.debugSessionId]);

  const initial = tab.browser?.targetUrl ?? DEFAULT_HOME;
  const historyRef = useRef<HistoryStack>({ entries: [initial], index: 0 });
  const [, bump] = useState(0);
  const forceNavUi = useCallback(() => bump((x) => x + 1), []);

  const [iframeKey, setIframeKey] = useState(0);
  const [urlBar, setUrlBar] = useState(initial);

  const designMode = tab.browser?.designMode ?? false;
  const devtoolsOpen = tab.browser?.devtoolsOpen ?? false;

  useEffect(() => {
    const u = tab.browser?.targetUrl ?? DEFAULT_HOME;
    historyRef.current = { entries: [u], index: 0 };
    setUrlBar(u);
    setIframeKey((k) => k + 1);
    forceNavUi();
  }, [tab.id, tab.browser?.targetUrl, forceNavUi]);

  useEffect(() => {
    const u = tab.browser?.targetUrl;
    if (u) setUrlBar(u);
  }, [tab.browser?.targetUrl]);

  const targetUrl = tab.browser?.targetUrl ?? DEFAULT_HOME;

  const iframeSrc = useMemo(
    // Iframe navigations cannot attach our `x-opencursor-session-token` header
    // and SameSite=Lax cookies don't reliably flow cross-port on localhost, so
    // we piggy-back auth on a dedicated `?__ocs_access=…` query param. The
    // server strips it before forwarding upstream and bootstraps the session
    // cookie on success so every sub-resource fetch from inside the iframe
    // authenticates via cookie automatically.
    () => buildIframeAuthenticatedUrl(buildBrowserProxyUrl(getServerBaseUrl(), targetUrl)),
    [targetUrl]
  );

  const consoleViewerSrc = useMemo(() => {
    const devtoolsPath = tab.browser?.devtoolsPath;
    if (!devtoolsPath) return null;
    const base = getServerBaseUrl().replace(/\/+$/, "");
    const normalized = devtoolsPath.startsWith("/") ? devtoolsPath : `/${devtoolsPath}`;
    return buildIframeAuthenticatedUrl(`${base}${normalized}`);
  }, [tab.browser?.devtoolsPath]);

  const pushDesignToGuest = useCallback((enabled: boolean) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    try {
      w.postMessage(
        { type: "opencursor-design", op: enabled ? "enable" : "disable" },
        "*"
      );
    } catch {
      /* ignore */
    }
  }, []);

  const designModeRef = useRef(designMode);
  useEffect(() => {
    designModeRef.current = designMode;
    pushDesignToGuest(designMode);
  }, [designMode, pushDesignToGuest]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (!isDesignGuestMessage(event.data)) {
        return;
      }
      const d = event.data;
      if (d.kind === "ready") {
        pushDesignToGuest(designModeRef.current);
        return;
      }
      if (d.kind === "state") {
        return;
      }
      if (d.captureId) {
        if (processedCaptureIdsRef.current.includes(d.captureId)) {
          return;
        }
        processedCaptureIdsRef.current = [
          ...processedCaptureIdsRef.current.slice(-49),
          d.captureId,
        ];
      }
      if (d.kind === "select") {
        void (async () => {
          applyBrowserDesignCapture({
            kind: "select",
            label: d.label,
            snippet: d.snippet,
            imageDataUrl: d.imageDataUrl ?? undefined,
            captureId: d.captureId,
          });
          if (d.imageDataUrl || !d.captureId) {
            return;
          }
          const fallbackImage = await captureRenderedFallback({
            pageUrl: d.pageUrl,
            pathIndices: d.pathIndices,
            rect: d.rect ?? null,
            viewport: d.viewport ?? null,
            scroll: d.scroll ?? null,
          });
          if (fallbackImage) {
            attachImageToBrowserDesignCapture(d.captureId, fallbackImage);
          }
        })();
      } else if (d.kind === "stroke") {
        void (async () => {
          applyBrowserDesignCapture({
            kind: "stroke",
            caption: d.caption,
            imageDataUrl: undefined,
            captureId: d.captureId,
          });
          const renderedBase = await captureRenderedFallback({
            pageUrl: d.pageUrl,
            pathIndices: d.pathIndices,
            rect: d.rect ?? null,
            viewport: d.viewport ?? null,
            scroll: d.scroll ?? null,
          });
          const imageDataUrl =
            renderedBase && d.imageDataUrl
              ? (await composeAnnotationOverlay(renderedBase, d.imageDataUrl)) ??
                renderedBase
              : renderedBase ?? d.imageDataUrl;
          if (imageDataUrl && d.captureId) {
            attachImageToBrowserDesignCapture(d.captureId, imageDataUrl);
          }
        })();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    applyBrowserDesignCapture,
    attachImageToBrowserDesignCapture,
    captureRenderedFallback,
    composeAnnotationOverlay,
    pushDesignToGuest,
  ]);

  const h = historyRef.current;
  const canBack = h.index > 0;
  const canForward = h.index < h.entries.length - 1;

  const devtoolsOpenRef = useRef(devtoolsOpen);
  useEffect(() => {
    devtoolsOpenRef.current = devtoolsOpen;
  }, [devtoolsOpen]);

  /**
   * When the console is open the real page is rendered by Chromium inside the
   * DevTools iframe — the outer proxy iframe is hidden to avoid duplicate
   * content. Navigation events (URL bar, back/forward/reload) still flow
   * through the IDE chrome, so dispatch them to Chromium over CDP as well.
   */
  const navigateChromium = useCallback(
    async (input:
      | { op: "goto"; url: string }
      | { op: "reload" | "back" | "forward" }
    ): Promise<void> => {
      const sid = debugSessionIdRef.current;
      if (!sid) return;
      try {
        await navigateBrowserDebugSession(sid, input);
      } catch {
        /* ignore — best-effort sync */
      }
    },
    []
  );

  const pushUrl = useCallback(
    (normalizedHref: string) => {
      const stack = historyRef.current;
      const nextEntries = [
        ...stack.entries.slice(0, stack.index + 1),
        normalizedHref,
      ];
      historyRef.current = {
        entries: nextEntries,
        index: nextEntries.length - 1,
      };
      dispatch({
        type: "UPDATE_BROWSER_TAB_URL",
        tabId: tab.id,
        targetUrl: normalizedHref,
      });
      setUrlBar(normalizedHref);
      if (devtoolsOpenRef.current) {
        void navigateChromium({ op: "goto", url: normalizedHref });
      } else {
        setIframeKey((k) => k + 1);
      }
      forceNavUi();
    },
    [dispatch, forceNavUi, navigateChromium, tab.id]
  );

  const go = useCallback(() => {
    try {
      const normalized = normalizeBrowserTargetUrl(urlBar).href;
      pushUrl(normalized);
    } catch {
      /* invalid URL — ignore */
    }
  }, [pushUrl, urlBar]);

  const back = useCallback(() => {
    const stack = historyRef.current;
    if (stack.index <= 0) return;
    stack.index -= 1;
    const u = stack.entries[stack.index]!;
    dispatch({
      type: "UPDATE_BROWSER_TAB_URL",
      tabId: tab.id,
      targetUrl: u,
    });
    setUrlBar(u);
    if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "back" });
    } else {
      setIframeKey((k) => k + 1);
    }
    forceNavUi();
  }, [dispatch, forceNavUi, navigateChromium, tab.id]);

  const forward = useCallback(() => {
    const stack = historyRef.current;
    if (stack.index >= stack.entries.length - 1) return;
    stack.index += 1;
    const u = stack.entries[stack.index]!;
    dispatch({
      type: "UPDATE_BROWSER_TAB_URL",
      tabId: tab.id,
      targetUrl: u,
    });
    setUrlBar(u);
    if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "forward" });
    } else {
      setIframeKey((k) => k + 1);
    }
    forceNavUi();
  }, [dispatch, forceNavUi, navigateChromium, tab.id]);

  const reload = useCallback(() => {
    if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "reload" });
      return;
    }
    setIframeKey((k) => k + 1);
  }, [navigateChromium]);

  const toggleDesignMode = useCallback(() => {
    dispatch({
      type: "UPDATE_BROWSER_TAB_META",
      tabId: tab.id,
      designMode: !designMode,
    });
  }, [dispatch, tab.id, designMode]);

  const tearDownDebugSession = useCallback(async () => {
    const sid = debugSessionIdRef.current ?? tab.browser?.debugSessionId;
    debugSessionIdRef.current = null;
    // Before killing Chromium, read where the user actually ended up — they
    // might have clicked a link in DevTools and navigated off the IDE's
    // recorded targetUrl. Syncing keeps the IDE URL bar + the freshly-shown
    // proxy iframe aligned on what the user just saw.
    let endedAt: string | null = null;
    if (sid) {
      try {
        const live = await getBrowserDebugSession(sid);
        endedAt = live?.currentUrl ?? null;
      } catch {
        /* ignore */
      }
      try {
        await deleteBrowserDebugSession(sid);
      } catch {
        /* ignore */
      }
    }
    if (endedAt && endedAt !== tab.browser?.targetUrl) {
      const stack = historyRef.current;
      stack.entries = [...stack.entries.slice(0, stack.index + 1), endedAt];
      stack.index = stack.entries.length - 1;
      setUrlBar(endedAt);
      dispatch({
        type: "UPDATE_BROWSER_TAB_URL",
        tabId: tab.id,
        targetUrl: endedAt,
      });
    }
    dispatch({
      type: "UPDATE_BROWSER_TAB_META",
      tabId: tab.id,
      devtoolsOpen: false,
      debugSessionId: null,
      devtoolsPath: null,
    });
    // Force the proxy iframe to re-render with the synced URL, since it was
    // unmounted (display: none) while the console was open.
    setIframeKey((k) => k + 1);
  }, [dispatch, tab.id, tab.browser?.debugSessionId, tab.browser?.targetUrl]);

  const toggleDevtools = useCallback(async () => {
    if (devtoolsOpen) {
      await tearDownDebugSession();
      setConsoleError(null);
      return;
    }
    if (!activeWorkspaceId) {
      setConsoleError("No active workspace.");
      return;
    }
    setConsoleError(null);
    try {
      // Point the headless Chromium at the real upstream URL, not our
      // `/browser/*` proxy. The proxy would require `__ocs_access` auth, and
      // the sidecar Chromium has no way to attach that token (it has its own
      // cookie jar, independent of the IDE user). Inspecting the real site
      // gives a fully working DevTools console (`1+1`, network, elements)
      // without the proxy auth wall.
      const { sessionId, devtoolsPath } = await createBrowserDebugSession({
        targetUrl,
        useIframeProxy: false,
      });
      debugSessionIdRef.current = sessionId;
      dispatch({
        type: "UPDATE_BROWSER_TAB_META",
        tabId: tab.id,
        devtoolsOpen: true,
        debugSessionId: sessionId,
        devtoolsPath,
      });
    } catch (error) {
      debugSessionIdRef.current = null;
      const message =
        error instanceof Error ? error.message : "Failed to open browser console.";
      setConsoleError(message);
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "error",
        title: "Browser console unavailable",
        message: message.includes("Playwright")
          ? `${message} Run: cd server && npx playwright install chromium`
          : message,
        autoDismissMs: 9000,
      });
    }
  }, [
    activeWorkspaceId,
    devtoolsOpen,
    dispatch,
    pushNotification,
    tab.id,
    targetUrl,
    tearDownDebugSession,
  ]);

  /**
   * Clean up the Chromium debug session ONLY when this tab unmounts (user
   * closed the browser tab). Do NOT fire cleanup when the session id changes,
   * because otherwise `toggleDevtools` itself trips the cleanup: it updates
   * `debugSessionIdRef.current` *before* React re-renders, so when React runs
   * the cleanup of the previous effect instance it reads the brand-new sid via
   * the ref and DELETEs the session we just created. The network log looked
   * like: POST sessions → DELETE sessions/<new-sid> → iframe loads 404. Keep
   * the dep list empty so cleanup only fires on unmount.
   */
  useEffect(() => {
    return () => {
      const sid = debugSessionIdRef.current;
      if (sid) {
        void deleteBrowserDebugSession(sid).catch(() => undefined);
      }
    };
  }, []);

  /**
   * When the tab mounts (or the React state rehydrates after a nav/layout
   * change) with an old `debugSessionId`, verify the server still has it. If
   * the server restarted, the in-memory Chromium was killed and the iframe
   * would just render a blank 404 — reset local state so the user can reopen
   * cleanly with a fresh click.
   */
  useEffect(() => {
    const sid = tab.browser?.debugSessionId;
    if (!sid || !tab.browser?.devtoolsOpen || !activeWorkspaceId) {
      return;
    }
    const expectedSid = sid;
    let cancelled = false;
    void (async () => {
      const live = await getBrowserDebugSession(sid).catch(() => null);
      if (cancelled || debugSessionIdRef.current !== expectedSid) return;
      if (!live) {
        debugSessionIdRef.current = null;
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          devtoolsOpen: false,
          debugSessionId: null,
          devtoolsPath: null,
        });
        return;
      }
      // Session is alive — make sure the devtools path in state is current.
      if (
        debugSessionIdRef.current === expectedSid &&
        live.devtoolsPath !== tab.browser?.devtoolsPath
      ) {
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          devtoolsPath: live.devtoolsPath,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    dispatch,
    tab.id,
    tab.browser?.debugSessionId,
    tab.browser?.devtoolsOpen,
    tab.browser?.devtoolsPath,
  ]);

  useEffect(() => {
    let cancelled = false;
    const target = tab.browser?.targetUrl ?? DEFAULT_HOME;
    void (async () => {
      const fav = await resolveFaviconForPage(target, getServerBaseUrl());
      if (cancelled) return;
      dispatch({
        type: "UPDATE_BROWSER_TAB_FAVICON",
        tabId: tab.id,
        faviconUrl: fav,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, tab.id, tab.browser?.targetUrl]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]"
      data-ide-browser-surface
      data-ide-editor-group={editorGroup}
    >
      <div
        className="flex shrink-0 flex-nowrap items-center gap-[6px] overflow-hidden border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[8px] py-[6px]"
        role="toolbar"
        aria-label="Browser navigation"
      >
        <button
          type="button"
          aria-label="Back"
          disabled={!canBack}
          onClick={back}
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-30"
        >
          <ArrowLeft className="size-[16px]" strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!canForward}
          onClick={forward}
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-30"
        >
          <ArrowRight className="size-[16px]" strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={reload}
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className="size-[15px]" strokeWidth={1.6} aria-hidden />
        </button>
        <input
          type="text"
          spellCheck={false}
          value={urlBar}
          onChange={(e) => setUrlBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          className="min-w-0 flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          aria-label="Address"
        />
        <button
          type="button"
          aria-label={designMode ? "Exit design mode" : "Design mode"}
          aria-pressed={designMode}
          onClick={toggleDesignMode}
          title={designMode ? "Exit design mode" : "Design mode (inspect elements)"}
          className={`flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent transition-colors hover:bg-[var(--accent-bg)] ${
            designMode
              ? "bg-[var(--accent-bg)] text-[var(--accent)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Pen className="size-[16px]" strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={devtoolsOpen ? "Close console" : "Open console"}
          aria-pressed={devtoolsOpen}
          disabled={!activeWorkspaceId}
          title={devtoolsOpen ? "Close console" : "Open browser console"}
          onClick={() => void toggleDevtools()}
          className={`flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-transparent transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-30 ${
            devtoolsOpen
              ? "bg-[var(--accent-bg)] text-[var(--accent)]"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <SquareTerminal className="size-[16px]" strokeWidth={1.6} aria-hidden />
        </button>
      </div>
      {consoleError ? (
        <div
          className="shrink-0 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--danger,#f48771)_18%,transparent)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)]"
          role="alert"
        >
          Browser console unavailable: {consoleError}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {/*
          When the console is open, the real page is rendered by the Chromium
          attached to DevTools — showing the outer proxy iframe on top of it
          would just duplicate the same page content. Hide (but keep mounted
          so design-mode guest state survives) via `hidden` + 0-basis flex so
          the DevTools iframe gets the full viewport.
        */}
        <div
          className={`min-h-0 overflow-hidden ${
            devtoolsOpen ? "hidden flex-[0_0_0%]" : "flex-1"
          }`}
          aria-hidden={devtoolsOpen || undefined}
        >
          <iframe
            ref={iframeRef}
            key={iframeKey}
            title="Browser preview"
            src={iframeSrc}
            onLoad={() => pushDesignToGuest(designModeRef.current)}
            className="h-full w-full border-0 bg-[var(--bg-main)]"
          />
        </div>
        {devtoolsOpen && consoleViewerSrc ? (
          <div
            className="min-h-0 flex-1 border-t border-[var(--border-subtle)]"
            data-ide-browser-devtools
          >
            <iframe
              title="Browser debug console"
              src={consoleViewerSrc}
              className="h-full w-full border-0 bg-[var(--bg-main)]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
