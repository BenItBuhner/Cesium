import type { ReactNode } from "react";

/**
 * Standalone-renderer shim for `convex/react`.
 *
 * Mobile Android CI installs workspace packages without the repo-root
 * `convex` dependency, and the renderer pins cloud mode to "disabled"
 * (`NEXT_PUBLIC_CONVEX_URL` is undefined in vite.config). CloudContext
 * therefore never mounts a real Convex client — these stubs only need to
 * satisfy import resolution.
 */

type ShimProps = { children?: ReactNode; client?: unknown };

export class ConvexReactClient {
  constructor(_url: string) {}

  query(_ref: unknown, _args?: unknown): Promise<unknown> {
    return Promise.resolve(null);
  }
}

export function ConvexProvider({ children }: ShimProps) {
  return children ?? null;
}

export function useConvex(): ConvexReactClient {
  return new ConvexReactClient("");
}

export function useConvexAuth(): {
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  return { isLoading: false, isAuthenticated: false };
}

export function useQuery(_query: unknown, _args?: unknown): undefined {
  return undefined;
}

export function useMutation(_mutation: unknown): (...args: unknown[]) => Promise<unknown> {
  return async () => undefined;
}
