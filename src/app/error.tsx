"use client";

import { RouteErrorFallback } from "@/components/errors/RouteErrorFallback";

/**
 * Route-level error boundary for every page under the root layout. Without
 * this file a render-time failure (most commonly a `ChunkLoadError` from a
 * lazily loaded panel after a redeploy) bubbled all the way up to Next's
 * default "Application error" page.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} />;
}
