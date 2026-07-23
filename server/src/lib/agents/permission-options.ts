import type {
  AgentPermissionCategory,
  AgentPermissionOption,
  AgentPermissionOptionKind,
} from "./types.js";

/** Canonical permission categories gated by Cesium (and referenced by remembered rules). */
export const AGENT_PERMISSION_CATEGORIES = [
  "editFile",
  "terminal",
  "mcpCall",
  "switchMode",
  "workflowLaunch",
] as const satisfies readonly AgentPermissionCategory[];

export const ORCHESTRATION_PERMISSION_CATEGORIES = [
  "editFile",
  "terminal",
  "mcpCall",
] as const satisfies readonly AgentPermissionCategory[];

export type OrchestrationPermissionCategory =
  (typeof ORCHESTRATION_PERMISSION_CATEGORIES)[number];

export const AGENT_PERMISSION_CATEGORY_LABELS: Record<AgentPermissionCategory, string> = {
  editFile: "Edit file",
  terminal: "Terminal",
  mcpCall: "MCP call",
  switchMode: "Switch mode",
  workflowLaunch: "Launch workflow",
};

/** Shared Accept / Always allow / Reject / Always reject options used across harnesses. */
export const STANDARD_PERMISSION_OPTIONS: AgentPermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/** @deprecated Prefer STANDARD_PERMISSION_OPTIONS — alias kept for call sites. */
export const PERMISSION_OPTIONS = STANDARD_PERMISSION_OPTIONS;

export function isAgentPermissionCategory(value: unknown): value is AgentPermissionCategory {
  return (
    value === "editFile" ||
    value === "terminal" ||
    value === "mcpCall" ||
    value === "switchMode" ||
    value === "workflowLaunch"
  );
}

export function isOrchestrationPermissionCategory(
  value: unknown
): value is OrchestrationPermissionCategory {
  return value === "editFile" || value === "terminal" || value === "mcpCall";
}

export function isPersistentPermissionOptionId(
  optionId: string | undefined
): optionId is "allow_always" | "reject_always" {
  return optionId === "allow_always" || optionId === "reject_always";
}

export function permissionDecisionFromOption(
  optionId: string | undefined
): "allow" | "reject" {
  return optionId === "allow_once" || optionId === "allow_always" ? "allow" : "reject";
}

export function permissionDecisionFromKind(
  kind: AgentPermissionOptionKind | undefined
): "allow" | "reject" | null {
  if (kind === "allow_once" || kind === "allow_always") {
    return "allow";
  }
  if (kind === "reject_once" || kind === "reject_always") {
    return "reject";
  }
  return null;
}

export function buildFallbackPermissionOptions(): AgentPermissionOption[] {
  return STANDARD_PERMISSION_OPTIONS.map((option) => ({ ...option }));
}

/**
 * Ensure provider-emitted once-options also expose the matching always-allow /
 * always-reject entries so users can add rules to the auto-allow list.
 */
export function withPersistentPermissionOptions(
  options: AgentPermissionOption[]
): AgentPermissionOption[] {
  const next = [...options];
  const hasAllowOnce = next.some((option) => option.kind === "allow_once");
  const hasAllowAlways = next.some((option) => option.kind === "allow_always");
  const hasRejectOnce = next.some((option) => option.kind === "reject_once");
  const hasRejectAlways = next.some((option) => option.kind === "reject_always");
  if (
    hasAllowOnce &&
    !hasAllowAlways &&
    !next.some((option) => option.optionId === "allow_always")
  ) {
    next.push({
      optionId: "allow_always",
      name: "Always allow",
      kind: "allow_always",
    });
  }
  if (
    hasRejectOnce &&
    !hasRejectAlways &&
    !next.some((option) => option.optionId === "reject_always")
  ) {
    next.push({
      optionId: "reject_always",
      name: "Always reject",
      kind: "reject_always",
    });
  }
  return next;
}

export function providerOptionIdForPermissionSelection(
  options: AgentPermissionOption[],
  selectedOptionId: string | undefined
): string | undefined {
  const selected = options.find((option) => option.optionId === selectedOptionId);
  if (!selected) {
    return selectedOptionId;
  }
  if (selected.kind === "allow_always") {
    return options.find((option) => option.kind === "allow_once")?.optionId ?? selected.optionId;
  }
  if (selected.kind === "reject_always") {
    return options.find((option) => option.kind === "reject_once")?.optionId ?? selected.optionId;
  }
  return selected.optionId;
}

export function providerOptionIdForRememberedPermission(
  options: AgentPermissionOption[],
  decision: "allow" | "reject"
): string | undefined {
  const onceKind = decision === "allow" ? "allow_once" : "reject_once";
  const alwaysKind = decision === "allow" ? "allow_always" : "reject_always";
  return (
    options.find((option) => option.kind === onceKind)?.optionId ??
    options.find((option) => option.kind === alwaysKind)?.optionId
  );
}
