"use client";

import { useCallback } from "react";
import { useReverification, useUser } from "@clerk/nextjs";
import { formatGithubConnectError } from "@/lib/github-clerk-errors";

/** Scopes the Codespaces integration needs on the GitHub OAuth token. */
export const REQUIRED_GITHUB_SCOPES = ["repo", "codespace"] as const;

type LinkedGithubAccount = {
  id: string;
  username?: string;
  approvedScopes: string;
  verification: { status: string | null } | null;
  reauthorize: (params: {
    additionalScopes?: string[];
    redirectUrl?: string;
  }) => Promise<{
    verification: { externalVerificationRedirectURL?: URL | null } | null;
  }>;
  destroy: () => Promise<unknown>;
};

export type ClerkGithubLinkState =
  | { kind: "none" }
  | {
      kind: "linked";
      username: string | null;
      verified: boolean;
      status: string | null;
      approvedScopes: string[];
      missingScopes: string[];
    };

export function describeGithubLink(
  account: Pick<LinkedGithubAccount, "username" | "approvedScopes" | "verification"> | undefined
): ClerkGithubLinkState {
  if (!account) {
    return { kind: "none" };
  }
  const approvedScopes = account.approvedScopes
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const missingScopes = REQUIRED_GITHUB_SCOPES.filter(
    (scope) => !approvedScopes.includes(scope)
  );
  const status = account.verification?.status ?? null;
  return {
    kind: "linked",
    username: account.username ?? null,
    verified: status === "verified",
    status,
    approvedScopes,
    missingScopes,
  };
}

/**
 * Link / unlink GitHub on the signed-in Clerk user.
 *
 * Adding or removing an SSO connection is a Clerk "sensitive action".
 * Calling `createExternalAccount` without `useReverification` fails with
 * "You need to provide additional verification to perform this operation"
 * even when GitHub SSO is configured. The hook prompts for a fresh
 * password / code, then retries.
 *
 * Connect is state-aware. Clerk keeps a GitHub external account around
 * even when its OAuth handshake never completed (`unverified` / `failed`),
 * and rejects a second `createExternalAccount` with "Another account is
 * already connected for this particular provider". In that case, or when
 * the approved scopes predate `repo` + `codespace`, re-run OAuth through
 * `reauthorize` instead of dead-ending.
 */
export function useClerkGithubLink() {
  const { user } = useUser();

  const findGithubAccount = useCallback((): LinkedGithubAccount | undefined => {
    return user?.externalAccounts.find(
      (entry) => entry.provider === "github"
    ) as LinkedGithubAccount | undefined;
  }, [user]);

  const linkState = describeGithubLink(findGithubAccount());

  const createGithubAccount = useReverification(async (redirectUrl: string) => {
    if (!user) {
      throw new Error("Sign in to your Cesium account first.");
    }
    return user.createExternalAccount({
      strategy: "oauth_github",
      redirectUrl,
    });
  });

  const reauthorizeGithubAccount = useReverification(
    async (account: LinkedGithubAccount, redirectUrl: string) =>
      account.reauthorize({
        redirectUrl,
        additionalScopes: [...REQUIRED_GITHUB_SCOPES],
      })
  );

  const destroyExternalAccount = useReverification(
    async (account: LinkedGithubAccount) => account.destroy()
  );

  const followRedirect = (
    result: { verification: { externalVerificationRedirectURL?: URL | null } | null } | null | undefined
  ) => {
    const redirect = result?.verification?.externalVerificationRedirectURL;
    if (!redirect) {
      throw new Error(
        "Clerk did not return a GitHub authorization URL. Enable GitHub SSO in the Clerk dashboard with a GitHub OAuth App (Client ID and Client Secret) and scopes read:user, user:email, repo, and codespace."
      );
    }
    window.location.href = redirect.toString();
  };

  /**
   * Start (or repair) the GitHub link. Always ends in a redirect to GitHub:
   * a fresh link uses `createExternalAccount`; an existing link (verified or
   * not) goes through `reauthorize`, which re-runs OAuth with the required
   * scopes and refreshes the token Clerk stores for the Backend API.
   */
  const connectGithub = useCallback(async (): Promise<void> => {
    const redirectUrl = window.location.href;
    const existing = findGithubAccount();
    if (existing) {
      followRedirect(await reauthorizeGithubAccount(existing, redirectUrl));
      return;
    }
    followRedirect(await createGithubAccount(redirectUrl));
  }, [createGithubAccount, findGithubAccount, reauthorizeGithubAccount]);

  const disconnectGithub = useCallback(async () => {
    if (!user) {
      throw new Error("Sign in to your Cesium account first.");
    }
    const account = findGithubAccount();
    if (!account) {
      throw new Error("No linked GitHub account was found on this Clerk user.");
    }
    await destroyExternalAccount(account);
  }, [destroyExternalAccount, findGithubAccount, user]);

  return {
    user,
    linkState,
    connectGithub,
    disconnectGithub,
    formatError: formatGithubConnectError,
  };
}

/**
 * Explain a Clerk-linked-but-Convex-says-no mismatch. Convex reports
 * `connected: false` with no error when Clerk's Backend API returns no
 * GitHub token for the user; the client can see *why* from the Clerk side.
 */
export function explainGithubLinkMismatch(state: ClerkGithubLinkState): string | null {
  if (state.kind !== "linked") {
    return null;
  }
  const who = state.username ? ` (${state.username})` : "";
  if (!state.verified) {
    return `Clerk has a GitHub account${who} attached, but its OAuth handshake never completed (status: ${state.status ?? "unknown"}). Click Connect GitHub to finish authorizing.`;
  }
  if (state.missingScopes.length > 0) {
    return `GitHub${who} is linked, but the token is missing the ${state.missingScopes.join(" and ")} scope${state.missingScopes.length > 1 ? "s" : ""}. Click Connect GitHub to re-authorize with the required scopes.`;
  }
  return `GitHub${who} is linked and verified in Clerk, but the Convex deployment could not fetch its token. Check that CLERK_SECRET_KEY on the production Convex deployment is the *live* secret for this Clerk instance and that the Convex functions have been deployed.`;
}
