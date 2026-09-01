import { TERMS_PATH } from "@/lib/legal/terms";

type ClerkAppearance = {
  layout?: {
    termsPageUrl?: string;
    privacyPageUrl?: string;
    logoPlacement?: "inside" | "outside" | "none";
  };
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

const legalUrls = {
  termsPageUrl: TERMS_PATH,
  privacyPageUrl: `${TERMS_PATH}#privacy`,
} as const;

/**
 * Shared Clerk chrome: Cesium tokens + legal URLs so SignIn / SignUp
 * pick up the same card and Clerk's built-in Terms footer links.
 */
export function getClerkAppearance(options?: {
  /** Flatten Clerk's own card so a host shell can own the border. */
  embedInHostCard?: boolean;
  /** Disable Clerk's Continue until express Terms consent. */
  primaryActionDisabled?: boolean;
}): ClerkAppearance {
  const embed = options?.embedInHostCard === true;
  const gatePrimary = options?.primaryActionDisabled === true;
  return {
    layout: legalUrls,
    options: legalUrls,
    variables: clerkVariables,
    elements: {
      rootBox: "w-full",
      ...(embed
        ? {
            cardBox: "w-full border-0 bg-transparent shadow-none",
            card: "border-0 bg-transparent shadow-none",
          }
        : {
            cardBox: "w-full",
          }),
      ...(gatePrimary
        ? {
            formButtonPrimary: "pointer-events-none opacity-40",
          }
        : {}),
    },
  };
}

/** Host card that wraps a flattened Clerk widget. */
export const clerkHostCardClass =
  "w-full max-w-[400px] overflow-hidden rounded-[0.75rem] border border-[var(--border-card)] bg-[var(--bg-card)] shadow-[0_1px_2px_color-mix(in_srgb,var(--text-primary)_6%,transparent)]";
