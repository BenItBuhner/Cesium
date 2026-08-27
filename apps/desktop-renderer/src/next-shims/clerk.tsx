/**
 * Standalone-renderer adapter for `@clerk/nextjs`.
 *
 * The real `@clerk/nextjs` package ships Next.js server actions
 * (`next/headers`, RedirectType redirects) that cannot bundle into the
 * Vite-built Electron/Android/iOS workbench. Everything the shared client
 * code actually uses is the React surface, which `@clerk/react` provides
 * without any Next.js dependency - so this adapter re-exports the real
 * components and hooks instead of inert stubs. Cloud mode (Convex + Clerk)
 * therefore works identically in the packaged apps and the hosted web app,
 * resolved from build env or the committed defaults in
 * `src/lib/cloud/cloud-defaults.ts`, with the runtime local-only switch in
 * Settings → Account.
 */
export {
  ClerkProvider,
  SignIn,
  SignInButton,
  SignOutButton,
  SignUp,
  SignUpButton,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/react";
