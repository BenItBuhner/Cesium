import type { AgentBackendId, AgentConversationRecord } from "./types.js";
import { getCursorSdkApiKey } from "../cursor-sdk-credentials.js";

export type CloudExecutionLifecycleAction = "archive" | "unarchive" | "delete";

export type CloudExecutionLifecycleHandler = (input: {
  providerSessionId: string;
  action: CloudExecutionLifecycleAction;
}) => Promise<void>;

export type CloudExecutionLifecycleHandlers = Partial<
  Record<AgentBackendId, CloudExecutionLifecycleHandler>
>;

/**
 * Per-backend hooks that mirror Cesium conversation lifecycle changes onto the
 * vendor-hosted cloud agent, so archiving a cloud conversation in Cesium also
 * parks it on the vendor's dashboard instead of leaving orphans behind. Any
 * future backend with `supportsCloudExecution` registers its handler here.
 */
const CLOUD_EXECUTION_LIFECYCLE_HANDLERS: CloudExecutionLifecycleHandlers = {
  "cursor-sdk": async ({ providerSessionId, action }) => {
    const apiKey = await getCursorSdkApiKey();
    if (!apiKey) {
      return;
    }
    // Lazy import keeps @cursor/sdk out of the hot path for engines that
    // never touch cloud conversations.
    const { Agent } = await import("@cursor/sdk");
    if (action === "archive") {
      await Agent.archive(providerSessionId, { apiKey });
    } else if (action === "unarchive") {
      await Agent.unarchive(providerSessionId, { apiKey });
    } else {
      await Agent.delete(providerSessionId, { apiKey });
    }
  },
};

export function isCloudExecutedConversation(
  conversation: Pick<AgentConversationRecord, "config" | "providerSessionId">
): boolean {
  return (
    conversation.config.executionTarget === "cloud" &&
    typeof conversation.providerSessionId === "string" &&
    conversation.providerSessionId.length > 0
  );
}

/**
 * Best-effort: failures are logged and swallowed so a vendor API hiccup never
 * blocks the local archive/unarchive/delete the user asked for.
 */
export async function propagateCloudExecutionLifecycle(
  conversation: Pick<AgentConversationRecord, "id" | "config" | "providerSessionId">,
  action: CloudExecutionLifecycleAction,
  /** Injectable for tests; defaults to the built-in per-backend registry. */
  handlers: CloudExecutionLifecycleHandlers = CLOUD_EXECUTION_LIFECYCLE_HANDLERS
): Promise<void> {
  if (!isCloudExecutedConversation(conversation)) {
    return;
  }
  const handler = handlers[conversation.config.backendId];
  if (!handler) {
    return;
  }
  try {
    await handler({
      providerSessionId: conversation.providerSessionId as string,
      action,
    });
  } catch (error) {
    console.warn(
      `[cloud-execution] Failed to ${action} remote cloud agent for conversation ${conversation.id}:`,
      error instanceof Error ? error.message : error
    );
  }
}
