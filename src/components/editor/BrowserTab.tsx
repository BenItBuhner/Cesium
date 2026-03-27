"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import {
  buildBrowserProxyUrl,
  normalizeBrowserTargetUrl,
} from "@/lib/browser-proxy-url";
import { resolveFaviconForPage } from "@/lib/browser-favicon";
import { getServerBaseUrl } from "@/lib/server-api";
import type { EditorTab } from "@/lib/types";
import type { EditorPanelAction } from "@/components/editor/editor-panel-state";

const DEFAULT_HOME = "http://localhost:3000/";

type HistoryStack = { entries: string[]; index: number };

export function BrowserTab({
  tab,
  dispatch,
}: {
  tab: EditorTab;
  dispatch: (action: EditorPanelAction) => void;
}) {
  const initial = tab.browser?.targetUrl ?? DEFAULT_HOME;
  const historyRef = useRef<HistoryStack>({ entries: [initial], index: 0 });
  const [, bump] = useState(0);
  const forceNavUi = useCallback(() => bump((x) => x + 1), []);

  const [iframeKey, setIframeKey] = useState(0);
  const [urlBar, setUrlBar] = useState(initial);

  useEffect(() => {
    const u = tab.browser?.targetUrl ?? DEFAULT_HOME;
    historyRef.current = { entries: [u], index: 0 };
    setUrlBar(u);
    setIframeKey((k) => k + 1);
    forceNavUi();
  }, [tab.id, forceNavUi]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]">
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
      </div>
      <iframe
        key={iframeKey}
        title="Browser preview"
        src={iframeSrc}
        className="min-h-0 w-full flex-1 border-0 bg-[var(--bg-main)]"
      />
    </div>
  );
}
