import React from "react";

/**
 * Standalone-renderer shim for `@clerk/nextjs`.
 *
 * The real package ships Next.js server actions (`next/headers`,
 * `RedirectType` redirects) that cannot bundle into the Vite-built
 * Electron/Android workbench. The renderer always runs with cloud mode
 * "disabled" (`NEXT_PUBLIC_CONVEX_URL` is pinned to undefined in
 * vite.config), so `CloudContext` renders plain children and never mounts a
 * real Clerk provider — these signed-out stubs only need to satisfy imports
 * and typechecking (including convex's `UseAuth` contract).
 */

type ShimProps = Record<string, unknown> & { children?: React.ReactNode };

export function ClerkProvider({ children }: ShimProps) {
  return <>{children}</>;
}

/** Wraps its child control; never triggers a sign-in flow in the shim. */
export function SignInButton({ children }: ShimProps) {
  return <>{children}</>;
}

export function SignOutButton({ children }: ShimProps) {
  return <>{children}</>;
}

/** Avatar menu placeholder; the disabled cloud mode never shows a user. */
export function UserButton(_props: ShimProps) {
  return null;
}

type ShimUser = {
  fullName?: string | null;
  primaryEmailAddress?: { emailAddress?: string | null } | null;
  imageUrl?: string | null;
  [key: string]: unknown;
};

export function useAuth(): {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  userId: string | undefined | null;
  sessionId: string | undefined | null;
  sessionClaims: Record<string, unknown> | undefined | null;
  orgId: string | undefined | null;
  orgRole: string | undefined | null;
  getToken: (options?: { template?: "convex"; skipCache?: boolean }) => Promise<string | null>;
  signOut: () => Promise<void>;
} {
  return {
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    sessionId: null,
    sessionClaims: null,
    orgId: null,
    orgRole: null,
    getToken: async () => null,
    signOut: async () => undefined,
  };
}

export function useUser(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: ShimUser | null | undefined;
} {
  return {
    isLoaded: true,
    isSignedIn: false,
    user: null,
  };
}
