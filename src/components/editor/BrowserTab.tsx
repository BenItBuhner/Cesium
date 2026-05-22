"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pen, RefreshCw, SquareTerminal } from "lucide-react";
import type { BrowserConsoleEntry, BrowserEngineEvent } from "@/lib/browser-engine";
import {
  REMOTE_BROWSER_EVENT_POLL_INTERVAL_MS,
  REMOTE_BROWSER_HOVER_REFRESH_DELAY_MS,
  REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS,
  REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS,
  REMOTE_BROWSER_POINTER_MOVE_THROTTLE_MS,
} from "@/lib/browser-engine";
import { getDesktopBrowserBridge } from "@/lib/desktop-browser-bridge";
import {
  buildBrowserProxyUrl,
  normalizeBrowserTargetUrl,
} from "@/lib/browser-proxy-url";
import { resolveFaviconForPage } from "@/lib/browser-favicon";
import { buildIframeAuthenticatedUrl } from "@/lib/auth-client";
import {
  captureBrowserDebugViewport,
  captureRenderedBrowserElementScreenshot,
  createBrowserDebugSession,
  deleteBrowserDebugSession,
  getBrowserDebugEvents,
  getBrowserDebugSession,
  getServerBaseUrl,
  markBrowserControlUserIntervention,
  navigateBrowserDebugSession,
  sendBrowserDebugInput,
  setBrowserControlLock,
} from "@/lib/server-api";
import type { EditorTab } from "@/lib/types";
import type {
  EditorGroup,
  EditorPanelAction,
} from "@/components/editor/editor-panel-state";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";

/**
 * Browser-tab home URL when a brand-new browser tab is opened with no explicit
 * target. On public deployments we should default to the current site origin,
 * not hard-coded localhost. The old constant caused odd behavior on
 * `https://cesium.techlitnow.com` because the "Open URL" prompt seeded the
 * field with `http://localhost:3000/`, and any non-full replacement could turn
 * into a garbage URL like `http://localhost:3000/https://google.com/`.
 */
function getDefaultHome(): string {
  if (
    typeof window !== "undefined" &&
    window.location?.origin &&
    /^https?:\/\//i.test(window.location.origin)
  ) {
    return `${window.location.origin}/`;
  }
  return "http://localhost:3000/";
}

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
  href?: string;
  title?: string;
  pathIndices?: number[];
  rect?: { left: number; top: number; width: number; height: number } | null;
  viewport?: { width: number; height: number } | null;
  scroll?: { x: number; y: number } | null;
} {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.source === "cesium-design-guest" && typeof d.kind === "string";
}

function elementViewportBounds(el: HTMLElement | null): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
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
  const { settings } = useGlobalSettings();
  const { pushNotification } = useWorkbenchNotifications();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nativeViewportRef = useRef<HTMLDivElement | null>(null);
  const nativeDevtoolsRef = useRef<HTMLDivElement | null>(null);
  const nativeSessionIdRef = useRef<string | null>(null);
  const remoteViewportRef = useRef<HTMLDivElement | null>(null);
  const remoteEventCursorRef = useRef(0);
  const remoteViewportTimerRef = useRef<number | null>(null);
  const remoteViewportInFlightRef = useRef(false);
  const remoteLastPointerMoveRef = useRef(0);
  const debugSessionIdRef = useRef<string | null>(null);
  const processedCaptureIdsRef = useRef<string[]>([]);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [nativeBrowserReady, setNativeBrowserReady] = useState(false);
  const [nativeProbeComplete, setNativeProbeComplete] = useState(false);
  const [remoteBrowserReady, setRemoteBrowserReady] = useState(false);
  const [remoteViewportImage, setRemoteViewportImage] = useState<string | null>(null);
  const [consoleEntries, setConsoleEntries] = useState<BrowserConsoleEntry[]>([]);

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

  useEffect(() => {
    nativeSessionIdRef.current = tab.browser?.nativeSessionId ?? null;
  }, [tab.browser?.nativeSessionId]);

  const defaultHome = getDefaultHome();
  const initial = tab.browser?.targetUrl ?? defaultHome;
  const historyRef = useRef<HistoryStack>({ entries: [initial], index: 0 });
  const [, bump] = useState(0);
  const forceNavUi = useCallback(() => bump((x) => x + 1), []);
  const lastNavHrefRef = useRef<string>(initial);
  const currentTargetUrlRef = useRef(initial);

  const [iframeKey, setIframeKey] = useState(0);
  const [urlBar, setUrlBar] = useState(initial);

  const designMode = tab.browser?.designMode ?? false;
  const devtoolsOpen = tab.browser?.devtoolsOpen ?? false;
  const newBrowserEnabled = settings.agents.newBrowser;
  const nativeSessionId = tab.browser?.nativeSessionId ?? null;
  const usingNativeBrowser =
    nativeBrowserReady &&
    tab.browser?.engine === "electron-native" &&
    Boolean(nativeSessionId);
  const usingRemoteBrowser =
    remoteBrowserReady &&
    tab.browser?.engine === "server-chromium" &&
    Boolean(tab.browser?.debugSessionId);

  useEffect(() => {
    currentTargetUrlRef.current = tab.browser?.targetUrl ?? defaultHome;
  }, [defaultHome, tab.browser?.targetUrl]);

  useEffect(() => {
    const u = tab.browser?.targetUrl ?? defaultHome;
    historyRef.current = { entries: [u], index: 0 };
    lastNavHrefRef.current = u;
    setUrlBar(u);
    setIframeKey((k) => k + 1);
    forceNavUi();
  }, [defaultHome, forceNavUi, tab.id]);

  useEffect(() => {
    const u = tab.browser?.targetUrl;
    if (u) setUrlBar(u);
  }, [tab.browser?.targetUrl]);

  const targetUrl = tab.browser?.targetUrl ?? defaultHome;
  const initialNativeTargetUrlRef = useRef(targetUrl);

  useEffect(() => {
    setNativeProbeComplete(false);
    if (!newBrowserEnabled && tab.browser?.engine !== "server-chromium") {
      setNativeBrowserReady(false);
      setNativeProbeComplete(true);
      dispatch({
        type: "UPDATE_BROWSER_TAB_META",
        tabId: tab.id,
        engine: "proxy",
        nativeSessionId: null,
        debugSessionId: null,
        devtoolsPath: null,
      });
      return;
    }
    if (tab.browser?.engine === "server-chromium") {
      setNativeBrowserReady(false);
      setNativeProbeComplete(true);
      return;
    }
    const bridge = getDesktopBrowserBridge();
    if (!bridge) {
      setNativeBrowserReady(false);
      setNativeProbeComplete(true);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let createdSessionId: string | null = null;

    const handleEvent = (event: BrowserEngineEvent & { sessionId: string }) => {
      if (event.sessionId !== nativeSessionIdRef.current) return;
      if (event.type === "navigation") {
        if (event.url) {
          const title = event.title?.trim() || undefined;
          if (event.url !== lastNavHrefRef.current) {
            const stack = historyRef.current;
            stack.entries = [...stack.entries.slice(0, stack.index + 1), event.url];
            stack.index = stack.entries.length - 1;
          }
          setUrlBar(event.url);
          currentTargetUrlRef.current = event.url;
          lastNavHrefRef.current = event.url;
          dispatch({
            type: "UPDATE_BROWSER_TAB_URL",
            tabId: tab.id,
            targetUrl: event.url,
            name: title,
          });
        }
        if (event.faviconUrl) {
          dispatch({
            type: "UPDATE_BROWSER_TAB_FAVICON",
            tabId: tab.id,
            faviconUrl: event.faviconUrl,
          });
        }
        forceNavUi();
      } else if (event.type === "console") {
        setConsoleEntries((entries) => [...entries.slice(-199), event.entry]);
      } else if (event.type === "network") {
        setConsoleEntries((entries) => [
          ...entries.slice(-199),
          {
            id: `network-${event.entry.id}`,
            ts: event.entry.ts,
            level:
              event.entry.status && event.entry.status >= 400
                ? "warning"
                : "info",
            source: "network",
            text: `${event.entry.status ?? ""} ${event.entry.url}`.trim(),
            url: event.entry.url,
          },
        ]);
      } else if (event.type === "error") {
        setConsoleError(event.message);
      }
    };

    void (async () => {
      const available = await Promise.resolve(bridge.isAvailable?.() ?? true).catch(
        () => false
      );
      if (cancelled || !available) {
        setNativeBrowserReady(false);
        setNativeProbeComplete(true);
        return;
      }
      unsubscribe = bridge.onEvent(handleEvent);
      try {
        const session = await bridge.createSession({
          tabId: tab.id,
          url: initialNativeTargetUrlRef.current,
        });
        if (cancelled) {
          await bridge.destroySession(session.id).catch(() => undefined);
          return;
        }
        createdSessionId = session.id;
        nativeSessionIdRef.current = session.id;
        setNativeBrowserReady(true);
        setNativeProbeComplete(true);
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          engine: "electron-native",
          nativeSessionId: session.id,
        });
      } catch (error) {
        setNativeBrowserReady(false);
        setNativeProbeComplete(true);
        setConsoleError(
          error instanceof Error ? error.message : "Native browser unavailable."
        );
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      const sid = createdSessionId ?? nativeSessionIdRef.current;
      if (sid) {
        void bridge.destroySession(sid).catch(() => undefined);
      }
    };
  }, [dispatch, forceNavUi, newBrowserEnabled, tab.id]);

  useEffect(() => {
    if (!usingNativeBrowser || !nativeSessionId) return;
    const bridge = getDesktopBrowserBridge();
    if (!bridge) return;

    let raf = 0;
    const syncBounds = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        void bridge.setBounds(
          nativeSessionId,
          elementViewportBounds(nativeViewportRef.current)
        );
        if (bridge.setDevtoolsBounds) {
          void bridge.setDevtoolsBounds(
            nativeSessionId,
            devtoolsOpen
              ? elementViewportBounds(nativeDevtoolsRef.current)
              : null
          );
        }
      });
    };

    const resizeObserver = new ResizeObserver(syncBounds);
    if (nativeViewportRef.current) resizeObserver.observe(nativeViewportRef.current);
    if (nativeDevtoolsRef.current) resizeObserver.observe(nativeDevtoolsRef.current);
    window.addEventListener("resize", syncBounds);
    syncBounds();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncBounds);
      void bridge.setBounds(nativeSessionId, null);
      if (bridge.setDevtoolsBounds) {
        void bridge.setDevtoolsBounds(nativeSessionId, null);
      }
    };
  }, [devtoolsOpen, nativeSessionId, usingNativeBrowser]);

  useEffect(() => {
    if (tab.browser?.engine === "server-chromium" && tab.browser?.debugSessionId) {
      debugSessionIdRef.current = tab.browser.debugSessionId;
      setRemoteBrowserReady(true);
      setConsoleError(null);
      return;
    }
    if (!newBrowserEnabled || !nativeProbeComplete || nativeBrowserReady || !activeWorkspaceId) {
      return;
    }
    let cancelled = false;
    let sessionId: string | null = null;
    void (async () => {
      try {
        const session = await createBrowserDebugSession({
          targetUrl: initialNativeTargetUrlRef.current,
          useIframeProxy: false,
        });
        if (cancelled) {
          await deleteBrowserDebugSession(session.sessionId).catch(() => undefined);
          return;
        }
        sessionId = session.sessionId;
        debugSessionIdRef.current = session.sessionId;
        setRemoteBrowserReady(true);
        setConsoleError(null);
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          engine: "server-chromium",
          debugSessionId: session.sessionId,
          devtoolsPath: session.devtoolsPath,
        });
      } catch {
        setRemoteBrowserReady(false);
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          engine: "proxy",
          debugSessionId: null,
          devtoolsPath: null,
        });
      }
    })();
    return () => {
      cancelled = true;
      const sid = sessionId ?? debugSessionIdRef.current;
      if (sid) {
        void deleteBrowserDebugSession(sid).catch(() => undefined);
      }
    };
  }, [
    activeWorkspaceId,
    dispatch,
    nativeBrowserReady,
    nativeProbeComplete,
    newBrowserEnabled,
    tab.browser?.debugSessionId,
    tab.browser?.engine,
    tab.id,
  ]);

  const refreshRemoteViewport = useCallback(async () => {
    const sid = debugSessionIdRef.current;
    if (!usingRemoteBrowser || !sid || remoteViewportInFlightRef.current) return;
    const bounds = elementViewportBounds(remoteViewportRef.current);
    const viewport =
      bounds && bounds.width >= 4 && bounds.height >= 4
        ? { width: Math.floor(bounds.width), height: Math.floor(bounds.height) }
        : { width: 1280, height: 720 };

    remoteViewportInFlightRef.current = true;
    try {
      const captured = await captureBrowserDebugViewport(sid, viewport);
      if (captured?.imageDataUrl) {
        setRemoteViewportImage(captured.imageDataUrl);
        if (captured.currentUrl && captured.currentUrl !== currentTargetUrlRef.current) {
          setUrlBar(captured.currentUrl);
          currentTargetUrlRef.current = captured.currentUrl;
          lastNavHrefRef.current = captured.currentUrl;
          dispatch({
            type: "UPDATE_BROWSER_TAB_URL",
            tabId: tab.id,
            targetUrl: captured.currentUrl,
          });
        }
      }
    } finally {
      remoteViewportInFlightRef.current = false;
    }
  }, [dispatch, tab.id, usingRemoteBrowser]);

  const scheduleRemoteViewportRefresh = useCallback(
    (delayMs = 0) => {
      if (!usingRemoteBrowser) return;
      if (remoteViewportTimerRef.current != null) {
        window.clearTimeout(remoteViewportTimerRef.current);
      }
      remoteViewportTimerRef.current = window.setTimeout(() => {
        remoteViewportTimerRef.current = null;
        void refreshRemoteViewport();
      }, delayMs);
    },
    [refreshRemoteViewport, usingRemoteBrowser]
  );

  useEffect(() => {
    if (!usingRemoteBrowser || !tab.browser?.debugSessionId) return;
    let cancelled = false;
    let timer: number | null = null;
    const bootstrapViewportTimers: number[] = [];
    const sid = tab.browser.debugSessionId;
    remoteEventCursorRef.current = 0;

    const readEvents = async () => {
      const events = await getBrowserDebugEvents(sid, remoteEventCursorRef.current);
      if (!cancelled && events) {
        remoteEventCursorRef.current = events.cursor;
        for (const event of events.events) {
          if (event.type === "console") {
            setConsoleEntries((entries) => [
              ...entries.slice(-199),
              {
                id: `remote-${event.seq}`,
                ts: event.ts,
                level: event.level,
                source: event.source,
                text: event.text,
                url: event.url,
                lineNumber: event.lineNumber,
                columnNumber: event.columnNumber,
              },
            ]);
          } else {
            setConsoleEntries((entries) => [
              ...entries.slice(-199),
              {
                id: `remote-network-${event.seq}`,
                ts: event.ts,
                level: event.status && event.status >= 400 ? "warning" : "info",
                source: "network",
                text: `${event.status ?? ""} ${event.url}`.trim(),
                url: event.url,
              },
            ]);
          }
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(readEvents, REMOTE_BROWSER_EVENT_POLL_INTERVAL_MS);
      }
    };

    for (const delay of [0, 150, 600]) {
      bootstrapViewportTimers.push(
        window.setTimeout(() => {
          void refreshRemoteViewport();
        }, delay)
      );
    }
    void readEvents();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      for (const bootstrapTimer of bootstrapViewportTimers) {
        window.clearTimeout(bootstrapTimer);
      }
      if (remoteViewportTimerRef.current != null) {
        window.clearTimeout(remoteViewportTimerRef.current);
        remoteViewportTimerRef.current = null;
      }
    };
  }, [
    refreshRemoteViewport,
    scheduleRemoteViewportRefresh,
    tab.browser?.debugSessionId,
    usingRemoteBrowser,
  ]);

  // Auto-heal legacy malformed browser-tab URLs from older builds / bad prompt
  // defaults (e.g. `http://localhost:3000/https://google.com/`). The proxy
  // builder already normalizes strings on the fly, but dispatching an explicit
  // UPDATE_BROWSER_TAB_URL also repairs the persisted tab title/name so the UI
  // stops showing garbage like `localhost:3000/https://google.com/`.
  useEffect(() => {
    const raw = tab.browser?.targetUrl;
    if (!raw) return;
    try {
      const normalized = normalizeBrowserTargetUrl(raw).href;
      if (normalized !== raw) {
        dispatch({
          type: "UPDATE_BROWSER_TAB_URL",
          tabId: tab.id,
          targetUrl: normalized,
        });
      }
    } catch {
      /* ignore malformed legacy URL */
    }
  }, [dispatch, tab.id, tab.browser?.targetUrl]);

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
  const showServerDevtoolsPanel = Boolean(!usingNativeBrowser && devtoolsOpen && consoleViewerSrc);
  const showNativeDevtoolsPanel = Boolean(usingNativeBrowser && devtoolsOpen);

  const pushDesignToGuest = useCallback((enabled: boolean) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    try {
      w.postMessage(
        { type: "cesium-design", op: enabled ? "enable" : "disable" },
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
      if (d.kind === "nav") {
        const href = d.href?.trim();
        if (!href) {
          return;
        }
        const title = d.title?.trim() || undefined;
        const current = lastNavHrefRef.current;
        if (href !== current) {
          const stack = historyRef.current;
          const currentEntry = stack.entries[stack.index];
          if (currentEntry !== href) {
            stack.entries = [...stack.entries.slice(0, stack.index + 1), href];
            stack.index = stack.entries.length - 1;
            forceNavUi();
          }
          lastNavHrefRef.current = href;
        }
        setUrlBar(href);
        if (href !== currentTargetUrlRef.current || title) {
          currentTargetUrlRef.current = href;
          dispatch({
            type: "UPDATE_BROWSER_TAB_URL",
            tabId: tab.id,
            targetUrl: href,
            name: title,
          });
        }
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
    dispatch,
    forceNavUi,
    pushDesignToGuest,
    tab.id,
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
      if (normalizedHref === currentTargetUrlRef.current) {
        setUrlBar(normalizedHref);
        return;
      }
      const stack = historyRef.current;
      const nextEntries = [
        ...stack.entries.slice(0, stack.index + 1),
        normalizedHref,
      ];
      historyRef.current = {
        entries: nextEntries,
        index: nextEntries.length - 1,
      };
      lastNavHrefRef.current = normalizedHref;
      currentTargetUrlRef.current = normalizedHref;
      dispatch({
        type: "UPDATE_BROWSER_TAB_URL",
        tabId: tab.id,
        targetUrl: normalizedHref,
      });
      setUrlBar(normalizedHref);
      const nativeSid = nativeSessionIdRef.current;
      if (nativeSid && nativeBrowserReady) {
        void getDesktopBrowserBridge()?.command(nativeSid, {
          op: "goto",
          url: normalizedHref,
        });
      } else if (debugSessionIdRef.current && remoteBrowserReady) {
        void navigateChromium({ op: "goto", url: normalizedHref });
        scheduleRemoteViewportRefresh(REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS);
      } else if (devtoolsOpenRef.current) {
        void navigateChromium({ op: "goto", url: normalizedHref });
      } else {
        setIframeKey((k) => k + 1);
      }
      forceNavUi();
    },
    [dispatch, forceNavUi, nativeBrowserReady, navigateChromium, remoteBrowserReady, scheduleRemoteViewportRefresh, tab.id]
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
    lastNavHrefRef.current = u;
    currentTargetUrlRef.current = u;
    dispatch({
      type: "UPDATE_BROWSER_TAB_URL",
      tabId: tab.id,
      targetUrl: u,
    });
    setUrlBar(u);
    const nativeSid = nativeSessionIdRef.current;
    if (nativeSid && nativeBrowserReady) {
      void getDesktopBrowserBridge()?.command(nativeSid, { op: "back" });
    } else if (debugSessionIdRef.current && remoteBrowserReady) {
      void navigateChromium({ op: "back" });
      scheduleRemoteViewportRefresh(REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS);
    } else if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "back" });
    } else {
      setIframeKey((k) => k + 1);
    }
    forceNavUi();
  }, [dispatch, forceNavUi, nativeBrowserReady, navigateChromium, remoteBrowserReady, scheduleRemoteViewportRefresh, tab.id]);

  const forward = useCallback(() => {
    const stack = historyRef.current;
    if (stack.index >= stack.entries.length - 1) return;
    stack.index += 1;
    const u = stack.entries[stack.index]!;
    lastNavHrefRef.current = u;
    currentTargetUrlRef.current = u;
    dispatch({
      type: "UPDATE_BROWSER_TAB_URL",
      tabId: tab.id,
      targetUrl: u,
    });
    setUrlBar(u);
    const nativeSid = nativeSessionIdRef.current;
    if (nativeSid && nativeBrowserReady) {
      void getDesktopBrowserBridge()?.command(nativeSid, { op: "forward" });
    } else if (debugSessionIdRef.current && remoteBrowserReady) {
      void navigateChromium({ op: "forward" });
      scheduleRemoteViewportRefresh(REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS);
    } else if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "forward" });
    } else {
      setIframeKey((k) => k + 1);
    }
    forceNavUi();
  }, [dispatch, forceNavUi, nativeBrowserReady, navigateChromium, remoteBrowserReady, scheduleRemoteViewportRefresh, tab.id]);

  const reload = useCallback(() => {
    const nativeSid = nativeSessionIdRef.current;
    if (nativeSid && nativeBrowserReady) {
      void getDesktopBrowserBridge()?.command(nativeSid, { op: "reload" });
      return;
    }
    if (debugSessionIdRef.current && remoteBrowserReady) {
      void navigateChromium({ op: "reload" });
      scheduleRemoteViewportRefresh(REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS);
      return;
    }
    if (devtoolsOpenRef.current) {
      void navigateChromium({ op: "reload" });
      return;
    }
    setIframeKey((k) => k + 1);
  }, [nativeBrowserReady, navigateChromium, remoteBrowserReady, scheduleRemoteViewportRefresh]);

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
      currentTargetUrlRef.current = endedAt;
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
    const nativeSid = nativeSessionIdRef.current;
    if (nativeSid && nativeBrowserReady) {
      const nextOpen = !devtoolsOpen;
      try {
        await getDesktopBrowserBridge()?.setDevtoolsOpen(nativeSid, nextOpen);
        dispatch({
          type: "UPDATE_BROWSER_TAB_META",
          tabId: tab.id,
          devtoolsOpen: nextOpen,
        });
        setConsoleError(null);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to toggle native DevTools.";
        setConsoleError(message);
      }
      return;
    }
    if (remoteBrowserReady && debugSessionIdRef.current) {
      dispatch({
        type: "UPDATE_BROWSER_TAB_META",
        tabId: tab.id,
        devtoolsOpen: !devtoolsOpen,
      });
      setConsoleError(null);
      return;
    }
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
      compact: true,
    });
    }
  }, [
    activeWorkspaceId,
    devtoolsOpen,
    dispatch,
    nativeBrowserReady,
    pushNotification,
    remoteBrowserReady,
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
    const target = tab.browser?.targetUrl ?? defaultHome;
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

  const browserLockState = tab.browser?.lockState;
  const browserLocked = Boolean(browserLockState?.locked);
  const browserViewport = tab.browser?.viewport;

  const unlockBrowser = () => {
    void setBrowserControlLock(tab.id, { locked: false, userInitiated: true })
      .then((result) => {
        dispatch({ type: "UPDATE_BROWSER_TAB_META", tabId: tab.id, lockState: result.tab.lockState });
      })
      .catch(() => undefined);
  };

  const markUserIntervention = (detail: string) => {
    if (browserLocked) return;
    if (!tab.browser?.controlSessionId) return;
    void markBrowserControlUserIntervention(tab.id, detail)
      .then((result) => {
        dispatch({ type: "UPDATE_BROWSER_TAB_META", tabId: tab.id, lockState: result.tab.lockState });
      })
      .catch(() => undefined);
  };

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
          disabled={!activeWorkspaceId && !usingNativeBrowser}
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
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onPointerDownCapture={() => markUserIntervention("User pointer input")}
        onWheelCapture={() => markUserIntervention("User wheel input")}
        onKeyDownCapture={() => markUserIntervention("User keyboard input")}
      >
        {browserViewport ? (
          <div className="pointer-events-none absolute left-[10px] top-[10px] z-20 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)]/85 px-[8px] py-[3px] font-mono text-[10px] text-[var(--text-secondary)]">
            {browserViewport.preset} {browserViewport.width}x{browserViewport.height}
          </div>
        ) : null}
        {browserLocked ? (
          <div className="absolute inset-0 z-30 flex items-start justify-end bg-transparent">
            <div className="m-[10px] flex items-center gap-[8px] rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)]/95 px-[10px] py-[6px] shadow-lg">
              <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                Browser locked for agent control
              </span>
              <button
                type="button"
                onClick={unlockBrowser}
                className="rounded-full bg-[var(--accent-bg)] px-[9px] py-[4px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
              >
                Unlock
              </button>
            </div>
          </div>
        ) : null}
        {/*
          When the console is open, the real page is rendered by the Chromium
          attached to DevTools — showing the outer proxy iframe on top of it
          would just duplicate the same page content. Hide (but keep mounted
          so design-mode guest state survives) via `hidden` + 0-basis flex so
          the DevTools iframe gets the full viewport.
        */}
        <div
          className={`min-h-0 overflow-hidden ${
            showServerDevtoolsPanel || showNativeDevtoolsPanel ? "hidden flex-[0_0_0%]" : "flex-1"
          }`}
          aria-hidden={showServerDevtoolsPanel || showNativeDevtoolsPanel || undefined}
        >
          {usingNativeBrowser ? (
            <div
              ref={nativeViewportRef}
              className="h-full w-full bg-[var(--bg-main)]"
              onMouseDown={() => {
                const sid = nativeSessionIdRef.current;
                if (sid) void getDesktopBrowserBridge()?.command(sid, { op: "focus" });
              }}
            />
          ) : usingRemoteBrowser ? (
            <div
              ref={remoteViewportRef}
              tabIndex={0}
              className="flex h-full w-full items-center justify-center overflow-hidden bg-[var(--bg-main)] outline-none"
              onMouseMove={(event) => {
                const now = performance.now();
                if (now - remoteLastPointerMoveRef.current < REMOTE_BROWSER_POINTER_MOVE_THROTTLE_MS) return;
                remoteLastPointerMoveRef.current = now;
                const sid = debugSessionIdRef.current;
                const rect = event.currentTarget.getBoundingClientRect();
                if (sid) {
                  void sendBrowserDebugInput(sid, {
                    type: "mouse",
                    action: "move",
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_HOVER_REFRESH_DELAY_MS));
                }
              }}
              onMouseDown={(event) => {
                const sid = debugSessionIdRef.current;
                const rect = event.currentTarget.getBoundingClientRect();
                if (sid) {
                  void sendBrowserDebugInput(sid, {
                    type: "mouse",
                    action: "down",
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                }
              }}
              onMouseUp={(event) => {
                const sid = debugSessionIdRef.current;
                const rect = event.currentTarget.getBoundingClientRect();
                if (sid) {
                  void sendBrowserDebugInput(sid, {
                    type: "mouse",
                    action: "up",
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                }
              }}
              onClick={(event) => {
                const sid = debugSessionIdRef.current;
                const rect = event.currentTarget.getBoundingClientRect();
                if (designMode && remoteViewportImage) {
                  applyBrowserDesignCapture({
                    kind: "select",
                    label: `Viewport at ${Math.round(event.clientX - rect.left)}, ${Math.round(event.clientY - rect.top)}`,
                    snippet: currentTargetUrlRef.current,
                    imageDataUrl: remoteViewportImage,
                    captureId: `remote-${Date.now()}`,
                  });
                  return;
                }
                if (sid) {
                  void sendBrowserDebugInput(sid, {
                    type: "mouse",
                    action: "click",
                    x: event.clientX - rect.left,
                    y: event.clientY - rect.top,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                }
              }}
              onWheel={(event) => {
                const sid = debugSessionIdRef.current;
                if (sid) {
                  void sendBrowserDebugInput(sid, {
                    type: "wheel",
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                }
              }}
              onKeyDown={(event) => {
                const sid = debugSessionIdRef.current;
                if (!sid) return;
                if (event.key.length === 1) {
                  void sendBrowserDebugInput(sid, {
                    type: "key",
                    action: "type",
                    key: event.key,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                } else {
                  void sendBrowserDebugInput(sid, {
                    type: "key",
                    action: "press",
                    key: event.key,
                  }).then(() => scheduleRemoteViewportRefresh(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS));
                }
              }}
            >
              {remoteViewportImage ? (
                <img
                  src={remoteViewportImage}
                  alt="Browser viewport"
                  className="h-full w-full object-fill"
                  draggable={false}
                />
              ) : (
                <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                  Starting Chromium browser...
                </span>
              )}
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              key={iframeKey}
              title="Browser preview"
              src={iframeSrc}
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              onLoad={() => pushDesignToGuest(designModeRef.current)}
              className="h-full w-full border-0 bg-[var(--bg-main)]"
            />
          )}
        </div>
        {showServerDevtoolsPanel ? (
          <div
            className="min-h-0 flex-1 border-t border-[var(--border-subtle)]"
            data-ide-browser-devtools
          >
            <iframe
              title="Browser debug console"
              src={consoleViewerSrc ?? undefined}
              className="h-full w-full border-0 bg-[var(--bg-main)]"
            />
          </div>
        ) : null}
        {showNativeDevtoolsPanel ? (
          <div className="flex min-h-0 flex-1 border-t border-[var(--border-subtle)]">
            <div ref={nativeViewportRef} className="min-h-0 flex-1 bg-[var(--bg-main)]" />
            <div
              ref={nativeDevtoolsRef}
              className="min-h-0 flex-1 border-l border-[var(--border-subtle)] bg-[var(--bg-panel)]"
              data-ide-browser-devtools
            />
          </div>
        ) : null}
        {(usingNativeBrowser || usingRemoteBrowser) &&
        consoleEntries.length > 0 &&
        !showNativeDevtoolsPanel &&
        !showServerDevtoolsPanel ? (
          <div className="max-h-[132px] shrink-0 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-secondary)]">
            {consoleEntries.slice(-5).map((entry) => (
              <div key={entry.id} className={entry.level === "error" ? "text-[var(--danger,#f48771)]" : ""}>
                [{entry.source}] {entry.text}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
