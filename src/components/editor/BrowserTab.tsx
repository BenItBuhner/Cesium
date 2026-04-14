"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle, RefreshCw, WandSparkles } from "lucide-react";
import {
  buildBrowserProxyUrl,
  normalizeBrowserTargetUrl,
} from "@/lib/browser-proxy-url";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { resolveFaviconForPage } from "@/lib/browser-favicon";
import { getServerBaseUrl } from "@/lib/server-api";
import type { DesignPromptSelection, EditorTab } from "@/lib/types";
import type {
  EditorGroup,
  EditorPanelAction,
} from "@/components/editor/editor-panel-state";

const DEFAULT_HOME = "http://localhost:3000/";

type HistoryStack = { entries: string[]; index: number };

type BrowserDesignBridgeMessage =
  | {
      source: "opencursor-browser-design";
      payload:
        | {
            type: "element-selection";
            label: string;
            selector?: string;
            targetUrl?: string;
            html: string;
            css?: string;
            javascript?: string;
            imageDataUrl: string;
          }
        | {
            type: "circle-selection";
            label: string;
            targetUrl?: string;
            imageDataUrl: string;
          }
        | {
            type: "selection-error";
            message: string;
          };
    };

function dataUrlToFile(dataUrl: string, baseName: string): File | null {
  const parts = dataUrl.split(",");
  const header = parts[0] ?? "";
  const body = parts[1] ?? "";
  const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
  if (!mimeMatch || !body) {
    return null;
  }
  try {
    const bytes = globalThis.atob(body);
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      array[index] = bytes.charCodeAt(index);
    }
    const mimeType = mimeMatch[1] ?? "image/png";
    const extension =
      mimeType === "image/jpeg"
        ? "jpg"
        : mimeType === "image/webp"
          ? "webp"
          : "png";
    return new File([array], `${baseName}.${extension}`, { type: mimeType });
  } catch {
    return null;
  }
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
  const initial = tab.browser?.targetUrl ?? DEFAULT_HOME;
  const historyRef = useRef<HistoryStack>({ entries: [initial], index: 0 });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [, bump] = useState(0);
  const forceNavUi = useCallback(() => bump((x) => x + 1), []);
  const { appendToPreferredComposer } = useOpenInEditor();
  const { pushNotification } = useWorkbenchNotifications();

  const [iframeKey, setIframeKey] = useState(0);
  const [urlBar, setUrlBar] = useState(initial);
  const [designModeEnabled, setDesignModeEnabled] = useState(false);
  const [captureState, setCaptureState] = useState<"idle" | "attaching">("idle");

  useEffect(() => {
    const u = tab.browser?.targetUrl ?? DEFAULT_HOME;
    historyRef.current = { entries: [u], index: 0 };
    setUrlBar(u);
    setIframeKey((k) => k + 1);
    setDesignModeEnabled(false);
    forceNavUi();
  }, [tab.id, tab.browser?.targetUrl, forceNavUi]);

  useEffect(() => {
    const u = tab.browser?.targetUrl;
    if (u) setUrlBar(u);
  }, [tab.browser?.targetUrl]);

  const targetUrl = tab.browser?.targetUrl ?? DEFAULT_HOME;

  const iframeSrc = useMemo(
    () => buildBrowserProxyUrl(getServerBaseUrl(), targetUrl),
    [targetUrl]
  );

  const h = historyRef.current;
  const canBack = h.index > 0;
  const canForward = h.index < h.entries.length - 1;

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
      setIframeKey((k) => k + 1);
      forceNavUi();
    },
    [dispatch, forceNavUi, tab.id]
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
    setIframeKey((k) => k + 1);
    forceNavUi();
  }, [dispatch, forceNavUi, tab.id]);

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
    setIframeKey((k) => k + 1);
    forceNavUi();
  }, [dispatch, forceNavUi, tab.id]);

  const reload = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

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

  useEffect(() => {
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow) {
      return;
    }
    iframeWindow.postMessage(
      {
        source: "opencursor-browser-parent",
        type: "set-design-mode",
        enabled: designModeEnabled,
      },
      "*"
    );
  }, [designModeEnabled, iframeKey]);

  useEffect(() => {
    const handleBridgeMessage = (event: MessageEvent<BrowserDesignBridgeMessage>) => {
      const data = event.data;
      if (!data || data.source !== "opencursor-browser-design") {
        return;
      }
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (data.payload.type === "selection-error") {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Design mode",
          message: data.payload.message,
          autoDismissMs: 8000,
        });
        setCaptureState("idle");
        return;
      }

      const file = dataUrlToFile(
        data.payload.imageDataUrl,
        data.payload.type === "circle-selection" ? "circled-region" : "design-selection"
      );
      const designSelections: DesignPromptSelection[] =
        data.payload.type === "element-selection"
          ? [
              {
                id:
                  globalThis.crypto?.randomUUID?.() ??
                  `design-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                label: data.payload.label,
                selector: data.payload.selector,
                targetUrl: data.payload.targetUrl,
                html: data.payload.html,
                css: data.payload.css,
                javascript: data.payload.javascript,
              },
            ]
          : [];

      setCaptureState("attaching");
      const targetDraftId = appendToPreferredComposer({
        files: file ? [file] : undefined,
        designSelections,
      });
      setCaptureState("idle");
      if (!targetDraftId) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Design mode",
          message: "Open a chat composer before attaching design captures.",
          autoDismissMs: 7000,
        });
        return;
      }
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "info",
        title: "Design mode",
        message:
          data.payload.type === "circle-selection"
            ? "Attached circled region to the active composer."
            : `Attached ${data.payload.label} to the active composer.`,
        autoDismissMs: 4500,
      });
    };

    window.addEventListener("message", handleBridgeMessage);
    return () => window.removeEventListener("message", handleBridgeMessage);
  }, [appendToPreferredComposer, pushNotification]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]"
      data-ide-browser-surface
      data-ide-editor-group={editorGroup}
    >
      <div
        className="flex shrink-0 flex-wrap items-center gap-[6px] border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[8px] py-[6px]"
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
          className="min-w-[120px] flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          aria-label="Address"
        />
        <button
          type="button"
          aria-pressed={designModeEnabled}
          onClick={() => setDesignModeEnabled((current) => !current)}
          className={`inline-flex min-h-[28px] items-center gap-[6px] rounded-[var(--radius-tab)] border px-[10px] py-[5px] text-[12px] transition-colors ${
            designModeEnabled
              ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
              : "border-[var(--border-card)] bg-[var(--bg-main)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
          title="Design mode: click an element to attach HTML/CSS/JS plus image, or drag to circle an image region."
        >
          {captureState === "attaching" ? (
            <LoaderCircle className="size-[14px] animate-spin" strokeWidth={2} aria-hidden />
          ) : (
            <WandSparkles className="size-[14px]" strokeWidth={1.8} aria-hidden />
          )}
          <span>{designModeEnabled ? "Design on" : "Design"}</span>
        </button>
      </div>
      <iframe
        ref={iframeRef}
        key={iframeKey}
        title="Browser preview"
        src={iframeSrc}
        className="min-h-0 w-full flex-1 border-0 bg-[var(--bg-main)]"
      />
    </div>
  );
}
