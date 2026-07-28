import { createHash } from "node:crypto";
import {
  findMatchingRememberedPermissionRule,
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
  type RememberedAgentPermissionRule,
} from "../global-settings-store.js";
import {
  isPersistentPermissionOptionId,
  providerOptionIdForRememberedPermission,
} from "./permission-options.js";
import type {
  AgentPermissionCategory,
  AgentPermissionOption,
  RememberedAgentPermissionMatchStyle,
} from "./types.js";

/**
 * Stable opaque tool key for harnesses whose native permission payloads are not
 * already namespaced (OpenCode, Antigravity, Codex, etc.).
 */
export function buildRememberedPermissionToolKey(
  namespace: string,
  ...parts: Array<string | undefined | null>
): string {
  const material = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\0");
  const digest = createHash("sha256")
    .update(material || namespace)
    .digest("hex")
    .slice(0, 40);
  return `${namespace}:${digest}`;
}

export async function persistRememberedPermissionChoice(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
  toolLabel: string;
  optionId?: string;
  optionKind?: RememberedAgentPermissionRule["optionKind"];
  permissionCategory?: AgentPermissionCategory;
  matchStyle?: RememberedAgentPermissionMatchStyle;
}): Promise<RememberedAgentPermissionRule | null> {
  const optionKind =
    input.optionKind ??
    (isPersistentPermissionOptionId(input.optionId) ? input.optionId : null);
  if (!optionKind || !input.toolKey.trim()) {
    return null;
  }
  // Storage hiccups (slow disk, transient pg failure) must not silently drop an
  // explicit "always" decision, so retry briefly before giving up.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await saveRememberedAgentPermissionRule({
        workspaceId: input.workspaceId,
        backendId: input.backendId,
        toolKey: input.toolKey,
        toolLabel: input.toolLabel,
        decision: optionKind === "allow_always" ? "allow" : "reject",
        optionId: input.optionId?.trim() || optionKind,
        optionKind,
        permissionCategory: input.permissionCategory,
        matchStyle: input.matchStyle ?? "exact",
      });
    } catch {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  return null;
}

export type ResolvedRememberedPermission =
  | {
      kind: "remembered";
      decision: "allow" | "reject";
      rule: RememberedAgentPermissionRule;
      providerOptionId?: string;
    }
  | {
      kind: "auto_accept";
      decision: "allow";
      providerOptionId?: string;
    }
  | { kind: "prompt" };

/**
 * Shared gate used by every harness before surfacing a permission card.
 * Remembered rules win; then the global auto-accept toggle; otherwise prompt.
 */
export async function resolveRememberedPermissionDecision(input: {
  workspaceId: string;
  backendId: string;
  toolKey: string;
  permissionCategory?: AgentPermissionCategory;
  options?: AgentPermissionOption[];
}): Promise<ResolvedRememberedPermission> {
  // One retry: a transient settings-load failure must not cause a stored
  // "always" decision to silently fall back to prompting mid-conversation.
  let settings = await getGlobalSettings().catch(() => undefined);
  if (!settings) {
    settings = await getGlobalSettings().catch(() => undefined);
  }
  if (!settings) {
    return { kind: "prompt" };
  }
  const rule = findMatchingRememberedPermissionRule(settings.agents.rememberedPermissions, {
    workspaceId: input.workspaceId,
    backendId: input.backendId,
    toolKey: input.toolKey,
    permissionCategory: input.permissionCategory,
  });
  if (rule) {
    return {
      kind: "remembered",
      decision: rule.decision,
      rule,
      providerOptionId: input.options
        ? providerOptionIdForRememberedPermission(input.options, rule.decision)
        : undefined,
    };
  }
  if (settings.agents.autoAcceptAllAgentPermissions) {
    return {
      kind: "auto_accept",
      decision: "allow",
      providerOptionId: input.options
        ? providerOptionIdForRememberedPermission(input.options, "allow")
        : undefined,
    };
  }
  return { kind: "prompt" };
}
