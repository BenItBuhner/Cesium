/**
 * Official subscription OAuth providers that explicitly allow third-party
 * harnesses to authenticate and use the user's paid compute.
 *
 * OpenAI (ChatGPT / Codex) and SpaceXAI / xAI (SuperGrok / X Premium) both
 * publish this path. Other vendors (Anthropic Claude Pro/Max, GitHub Copilot
 * editor tokens, Google Gemini CLI / Antigravity) treat unofficial reuse as
 * ToS abuse and will lock the account - do not offer or consume those.
 */

export const SUBSCRIPTION_OAUTH_PROVIDER_IDS = ["openai-codex", "xai"] as const;

export type SubscriptionOAuthProviderId = (typeof SUBSCRIPTION_OAUTH_PROVIDER_IDS)[number];

/** Leftover unofficial logins we strip on sight so Cesium never spends them. */
export const BLOCKED_SUBSCRIPTION_OAUTH_PROVIDER_IDS = [
  "anthropic",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
  "google",
] as const;

export function isSubscriptionOAuthProviderId(
  providerId: string
): providerId is SubscriptionOAuthProviderId {
  return (SUBSCRIPTION_OAUTH_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export function isBlockedSubscriptionOAuthProviderId(providerId: string): boolean {
  return (BLOCKED_SUBSCRIPTION_OAUTH_PROVIDER_IDS as readonly string[]).includes(
    providerId
  );
}

export const SUBSCRIPTION_OAUTH_LABELS: Record<SubscriptionOAuthProviderId, string> = {
  "openai-codex": "ChatGPT (Codex subscription)",
  xai: "SpaceXAI SuperGrok",
};

export const SUBSCRIPTION_OAUTH_DESCRIPTIONS: Record<SubscriptionOAuthProviderId, string> = {
  "openai-codex":
    "Sign in with your ChatGPT Plus/Pro account to run Codex models over the official ChatGPT backend.",
  xai:
    "Sign in with SuperGrok or X Premium. Uses SpaceXAI's public Grok-CLI OAuth client (the same device-code flow OpenCode and other official partners use) to call Grok models on api.x.ai.",
};
