/**
 * Convex auth providers. Clerk is attached only when the deployment has
 * `CLERK_JWT_ISSUER_DOMAIN` set (the Clerk Frontend API URL, paired with a
 * Clerk JWT template named "convex"). Local/dev deployments without Clerk
 * fall back to gated device keys (see `lib/identity.ts`).
 *
 * The env var is read via computed access so deployments WITHOUT Clerk are
 * not forced to define it (Convex rejects pushes when a directly-referenced
 * `process.env.*` var is unset).
 */
function readOptionalEnv(name: string): string | undefined {
  const env = process.env as unknown as Record<string, string | undefined>;
  // Membership check first: Convex's auth-config evaluator throws on `get`
  // of unset vars (get-convex/convex-backend#309), but not on `in`.
  if (!(name in env)) {
    return undefined;
  }
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const clerkIssuerDomain = readOptionalEnv("CLERK_JWT_ISSUER_DOMAIN");

const authConfig = {
  providers: clerkIssuerDomain
    ? [
        {
          domain: clerkIssuerDomain,
          applicationID: "convex",
        },
      ]
    : [],
};

export default authConfig;
