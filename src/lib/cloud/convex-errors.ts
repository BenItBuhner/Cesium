import { ConvexError } from "convex/values";

/**
 * Human-actionable message for a failed Convex action call.
 *
 * Production Convex deployments redact plain thrown errors into an opaque
 * "[CONVEX ...] Server Error" envelope; only `ConvexError` data survives to
 * the client. The GitHub proxy actions wrap their failures (GitHub billing
 * limits, max-codespaces caps, expired tokens, ...) in `ConvexError`, so
 * unwrap that data here. Dev deployments and older deployed functions still
 * throw plain errors whose message carries the cause - keep those as-is.
 */
export function convexActionErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data.trim()) {
      return data.trim();
    }
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string" &&
      (data as { message: string }).message.trim()
    ) {
      return (data as { message: string }).message.trim();
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  // Dev deployments surface plain thrown errors as a full diagnostic blob
  // ("[CONVEX M(...)] [Request ID: ...] Server Error\nUncaught Error: <the
  // actual message>\n  at handler (...)"). Extract the human message so UI
  // surfaces never render stack traces.
  const uncaught = raw.match(/Uncaught (?:[A-Za-z]*Error|error): ?([^\n]+)/);
  if (uncaught?.[1]?.trim()) {
    return uncaught[1].trim();
  }
  return raw;
}

/**
 * Run one Convex action call and rethrow its failure as a plain `Error`
 * carrying the unwrapped, user-readable message. Callers all over the
 * workbench render `error.message` directly, so translating here fixes
 * every surface at once.
 */
export async function unwrapConvexActionErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(convexActionErrorMessage(error));
  }
}
