"use client";

import { useCallback } from "react";
import { useReverification, useUser } from "@clerk/nextjs";
import { formatGithubConnectError } from "@/lib/github-clerk-errors";

type DestroyableExternalAccount = {
  provider: string;
  destroy: () => Promise<unknown>;
};

/**
 * Link / unlink GitHub on the signed-in Clerk user.
 *
 * Adding or removing an SSO connection is a Clerk "sensitive action".
 * Calling `createExternalAccount` without `useReverification` fails with
 * "You need to provide additional verification to perform this operation"
 * even when GitHub SSO is configured. The hook prompts for a fresh
 * password / code, then retries.
 */
export function useClerkGithubLink() {
  const { user } = useUser();

  const createGithubAccount = useReverification(async (redirectUrl: string) => {
    if (!user) {
      throw new Error("Sign in to your Cesium account first.");
    }
    return user.createExternalAccount({
      strategy: "oauth_github",
      redirectUrl,
    });
  });

  const destroyExternalAccount = useReverification(
    async (account: DestroyableExternalAccount) => account.destroy()
  );

  const connectGithub = useCallback(async () => {
    const external = await createGithubAccount(window.location.href);
    const redirect = external.verification?.externalVerificationRedirectURL;
    if (!redirect) {
      throw new Error(
        "Clerk did not return a GitHub authorization URL. Enable GitHub SSO in the Clerk dashboard with a GitHub OAuth App (Client ID and Client Secret) and scopes read:user, user:email, repo, and codespace."
      );
    }
    window.location.href = redirect.toString();
  }, [createGithubAccount]);

  const disconnectGithub = useCallback(async () => {
    if (!user) {
      throw new Error("Sign in to your Cesium account first.");
    }
    const account = user.externalAccounts.find(
      (entry) => entry.provider === "github"
    );
    if (!account) {
      throw new Error("No linked GitHub account was found on this Clerk user.");
    }
    await destroyExternalAccount(account);
  }, [destroyExternalAccount, user]);

  return {
    user,
    connectGithub,
    disconnectGithub,
    formatError: formatGithubConnectError,
  };
}
