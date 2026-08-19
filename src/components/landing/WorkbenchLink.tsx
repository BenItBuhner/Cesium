"use client";

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

type WorkbenchLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  children: ReactNode;
};

export function shouldHardNavigateWorkbench(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    "defaultPrevented" | "button" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey"
  >
): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  );
}

/**
 * Landing-page CTA into the agent workbench.
 *
 * Next.js `<Link>` client transitions can no-op from this fixed full-viewport
 * marketing shell (URL stays `/`, you never leave the hero). A real document
 * navigation always lands on {@link WORKSPACE_ROUTE}.
 */
export function WorkbenchLink({
  children,
  onClick,
  ...props
}: WorkbenchLinkProps) {
  return (
    <a
      {...props}
      href={WORKSPACE_ROUTE}
      onClick={(event) => {
        onClick?.(event);
        if (!shouldHardNavigateWorkbench(event)) {
          return;
        }
        event.preventDefault();
        window.location.assign(WORKSPACE_ROUTE);
      }}
    >
      {children}
    </a>
  );
}
