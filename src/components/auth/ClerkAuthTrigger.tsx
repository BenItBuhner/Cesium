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
  shouldUseHostedClerkAuth,
} from "@/lib/cloud/clerk-urls";
import { openExternalUrl } from "@/lib/mobile-bridge";

export function useHostedClerkAuth(): boolean {
  const cloud = useCloudContext();
  return shouldUseHostedClerkAuth(
    typeof window === "undefined"
      ? null
      : { protocol: window.location.protocol, hostname: window.location.hostname },
    cloud.status
  );
}

export function openHostedClerkAuth(mode: "sign-in" | "sign-up" = "sign-in"): void {
  openExternalUrl(
    mode === "sign-up" ? getHostedClerkSignUpUrl() : getHostedClerkSignInUrl()
  );
}

/**
 * Sign-in / sign-up control that stays in-app on allowlisted Clerk origins
 * and opens the hosted account pages (with a native return ticket) from
 * file:// / localhost packaged clients.
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
