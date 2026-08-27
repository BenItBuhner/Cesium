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
  // Convex's push-time auth-config evaluator exposes env vars through a
  // proxy with quirky semantics: `get` of an unset var can throw
  // (get-convex/convex-backend#309), and the `in` membership trap is not
  // implemented on cloud deployments - an `in` guard reads as false even
  // when the variable IS set, which silently emptied the provider list and
  // broke Clerk sign-in in production. Direct access inside try/catch is
  // correct under both behaviors: set vars come through, unset vars either
  // throw (caught) or return undefined.
  try {
    const value = (process.env as unknown as Record<string, string | undefined>)[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
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
