"use client";

import { RouteErrorFallback } from "@/components/errors/RouteErrorFallback";
import { buildThemeBootstrapScript } from "@/lib/theme-bootstrap";
import "./globals.css";

const themeBootstrap = buildThemeBootstrapScript();

/**
 * Last-resort boundary: replaces the root layout when the layout itself (or
 * `error.tsx`) throws. It has to render its own `<html>`/`<body>`, so the
 * theme bootstrap is inlined again to keep dark-mode users off a white flash.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <RouteErrorFallback error={error} reset={reset} />
      </body>
    </html>
  );
}
