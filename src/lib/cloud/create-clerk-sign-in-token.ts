import { NATIVE_CLERK_HANDOFF_TOKEN_TTL_SECONDS } from "@/lib/cloud/clerk-native-handoff";

const CLERK_API_BASE = "https://api.clerk.com/v1";

export async function requestClerkSignInToken(input: {
  userId: string;
  secretKey: string;
  expiresInSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const userId = input.userId.trim();
  const secretKey = input.secretKey.trim();
  if (!userId) {
    throw new Error("Missing Clerk user id.");
  }
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is not configured.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${CLERK_API_BASE}/sign_in_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: userId,
      expires_in_seconds:
        input.expiresInSeconds ?? NATIVE_CLERK_HANDOFF_TOKEN_TTL_SECONDS,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Clerk sign-in token failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  const data = (await response.json()) as { token?: unknown };
  if (typeof data.token !== "string" || !data.token.trim()) {
    throw new Error("Clerk sign-in token response was empty.");
  }
  return data.token.trim();
}

export async function createClerkNativeHandoffTicket(userId: string): Promise<string> {
  return requestClerkSignInToken({
    userId,
    secretKey: process.env.CLERK_SECRET_KEY ?? "",
  });
}
