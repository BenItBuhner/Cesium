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
 * Shared Clerk chrome: Cesium tokens + legal URLs so the real SignIn / SignUp
 * widgets pick up Terms links in Clerk's own footer.
 */
export function getClerkAppearance(): ClerkAppearance {
  return {
    layout: legalUrls,
    options: legalUrls,
    variables: clerkVariables,
    elements: {
      rootBox: "w-full",
      cardBox: "w-full",
    },
  };
}
