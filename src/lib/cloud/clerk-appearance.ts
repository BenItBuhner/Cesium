import type { CSSProperties } from "react";
import { LICENSE_PATH, TERMS_PATH } from "@/lib/legal/terms";

type ClerkAppearance = {
  options?: {
    termsPageUrl?: string;
    privacyPageUrl?: string;
    logoPlacement?: "inside" | "none";
  };
  variables?: Record<string, string>;
  elements?: Record<string, string>;
};

const clerkVariables = {
  colorPrimary: "var(--accent)",
  colorBackground: "var(--bg-card)",
  colorNeutral: "var(--text-secondary)",
  colorText: "var(--text-primary)",
  colorTextOnPrimaryBackground: "var(--bg-main)",
  colorTextSecondary: "var(--text-secondary)",
  colorInputBackground: "var(--bg-panel)",
  colorInputText: "var(--text-primary)",
  colorDanger: "var(--status-error)",
  borderRadius: "0.5rem",
  fontFamily: "inherit",
  fontFamilyButtons: "inherit",
};

/**
 * Shared Clerk chrome: Cesium tokens + legal URLs so SignIn / SignUp
 * pick up the same card and the built-in Terms footer links.
 */
export function getClerkAppearance(options?: {
  /** Flatten Clerk's own card so a host shell can own the border. */
  embedInHostCard?: boolean;
}): ClerkAppearance {
  const embed = options?.embedInHostCard === true;
  return {
    options: {
      termsPageUrl: TERMS_PATH,
      privacyPageUrl: `${TERMS_PATH}#privacy`,
    },
    variables: clerkVariables,
    elements: embed
      ? {
          rootBox: "w-full",
          cardBox: "w-full border-0 bg-transparent shadow-none",
          card: "border-0 bg-transparent shadow-none",
          footer: "hidden",
          footerAction: "hidden",
        }
      : {
          rootBox: "w-full",
          cardBox: "w-full",
        },
  };
}

/** Host card that wraps a flattened Clerk widget plus our legal row. */
export const clerkHostCardClass =
  "w-full max-w-[400px] overflow-hidden rounded-[0.75rem] border border-[var(--border-card)] bg-[var(--bg-card)] shadow-[0_1px_2px_color-mix(in_srgb,var(--text-primary)_6%,transparent)]";

export const clerkHostLegalRowClass =
  "border-t border-[var(--border-subtle)] px-[24px] py-[14px]";

export const clerkWidgetGateStyle = {
  opacity: 0.42,
} satisfies CSSProperties;
