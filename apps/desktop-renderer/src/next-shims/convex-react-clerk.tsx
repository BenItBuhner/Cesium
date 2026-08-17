import type { ReactNode } from "react";

/**
 * Standalone-renderer shim for `convex/react-clerk`.
 *
 * Cloud mode is pinned to "disabled" in the desktop/Android workbench, so
 * CloudContext never mounts ConvexProviderWithClerk. This pass-through keeps
 * the import resolvable when the root `convex` package is not installed.
 */

type ShimProps = {
  children?: ReactNode;
  client?: unknown;
  useAuth?: unknown;
};

export function ConvexProviderWithClerk({ children }: ShimProps) {
  return <>{children}</>;
}
