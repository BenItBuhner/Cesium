"use client";

import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  getHostedClerkSignInUrl,
  getHostedClerkSignUpUrl,
  isPackagedClerkRuntime,
  readClerkAuthLocation,
  shouldUseHostedClerkAuth,
} from "@/lib/cloud/clerk-urls";
import { openExternalUrl } from "@/lib/mobile-bridge";

export function useHostedClerkAuth(): boolean {
  const cloud = useCloudContext();
  return shouldUseHostedClerkAuth(readClerkAuthLocation(), cloud.status, {
    packaged: isPackagedClerkRuntime(),
  });
}

export function openHostedClerkAuth(mode: "sign-in" | "sign-up" = "sign-in"): void {
  openExternalUrl(
    mode === "sign-up" ? getHostedClerkSignUpUrl() : getHostedClerkSignInUrl()
  );
}

/**
 * Sign-in / sign-up control. The production website keeps the in-app Clerk
 * modal. Every packaged / emulator / localhost client opens the hosted
 * account pages and comes back with a native return ticket - Settings →
 * Account uses this same path as first-run, so guest → Sign in does not
 * mount a Clerk modal that dies on a prohibited redirect scheme.
 */
export function ClerkAuthTrigger({
  mode = "sign-in",
  children,
}: {
  mode?: "sign-in" | "sign-up";
  children: ReactNode;
}) {
  const hosted = useHostedClerkAuth();
  if (hosted) {
    if (isValidElement(children)) {
      const child = children as ReactElement<{
        onClick?: (event: MouseEvent<HTMLElement>) => void;
      }>;
      return cloneElement(child, {
        onClick: (event: MouseEvent<HTMLElement>) => {
          child.props.onClick?.(event);
          openHostedClerkAuth(mode);
        },
      });
    }
    return (
      <button type="button" onClick={() => openHostedClerkAuth(mode)}>
        {children}
      </button>
    );
  }
  const Button = mode === "sign-up" ? SignUpButton : SignInButton;
  return <Button mode="modal">{children}</Button>;
}
