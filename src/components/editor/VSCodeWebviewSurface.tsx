"use client";

import type { EditorTab } from "@/lib/types";

interface VSCodeWebviewSurfaceProps {
  tab: EditorTab;
}

export function VSCodeWebviewSurface({ tab }: VSCodeWebviewSurfaceProps) {
  const webview = tab.vscodeWebview;
  if (!webview) {
    return null;
  }

  return (
    <div className="h-full w-full bg-[var(--bg-main)]">
      <iframe
        key={webview.panelId}
        title={tab.name}
        srcDoc={webview.html}
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
