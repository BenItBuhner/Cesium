import type { AgentPermissionCategory } from "./types.js";
import {
  isGoalToolName,
  isOrchestrationToolName,
  isWorkflowToolName,
  normalizeCesiumToolName,
} from "./cesium-mode-policy.js";
import type { CesiumToolDefinition } from "./cesium/features/types.js";

/**
 * Cesium agent capability profiles ("Code", "Work", custom presets).
 *
 * A profile is a capability envelope + persona, orthogonal to modes:
 * modes remain the operating posture (agent/plan/ask/goal/workflow/
 * orchestration) while the profile decides which tools are advertised and
 * permitted, which prompt base/persona is used, which MCP servers are
 * reachable, and which permission-category defaults apply.
 */

export type CesiumProfilePromptBase = "code" | "work" | "minimal";

export type CesiumProfilePermissionOverride = "ask" | "allow" | "deny";

export type CesiumAgentProfile = {
  id: string;
  name: string;
  description: string;
  /** Built-ins ship in code, are non-deletable, and are duplicated to customize. */
  builtIn: boolean;
  prompt: {
    /** Which base persona/system-prompt sections to render. */
    base: CesiumProfilePromptBase;
    /** Verbatim user-authored text appended as its own Profile Instructions section. */
    customInstructions: string;
  };
  tools: {
    /** Top-level tool-name allowlist; core control tools are always locked on. */
    allowed: "all" | string[];
    /** MCP serverId allowlist enforced inside call_mcp_tool. */
    mcpServers: "all" | string[];
  };
  /** Per-category permission defaults that win over settings-level toolPermissions. */
  permissionOverrides: Partial<
    Record<AgentPermissionCategory, CesiumProfilePermissionOverride>
  >;
};

export type CesiumProfileToolPolicyDecision = {
  allowed: boolean;
  reason?: string;
};

/** Tools every profile keeps regardless of allowlist so the harness stays sane. */
export const CESIUM_PROFILE_LOCKED_TOOLS: readonly string[] = [
  "read_file",
  "grep",
  "ask_question",
  "todo",
  "wait",
  "switch_mode",
];

export type CesiumProfileToolGroup = {
  id: string;
  label: string;
  tools: string[];
};

/** Grouped tool inventory for profile editors and allowlist validation. */
export const CESIUM_PROFILE_TOOL_GROUPS: readonly CesiumProfileToolGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    tools: ["read_file", "grep", "write_file", "edit_file", "terminal"],
  },
  {
    id: "control",
    label: "Control",
    tools: ["switch_mode", "wait", "todo", "ask_question"],
  },
  {
    id: "plans",
    label: "Plans",
    tools: ["create_plan", "update_plan", "read_plan", "finalize_plan"],
  },
  {
    id: "goal",
    label: "Goal",
    tools: ["goal_set", "goal_pause", "goal_block", "goal_summarize", "goal_complete"],
  },
  {
    id: "workflow",
    label: "Workflow",
    tools: ["workflow_run", "workflow_status", "workflow_await"],
  },
  {
    id: "history",
    label: "History & Conversations",
    tools: [
      "search_history",
      "read_history_page",
      "list_conversations",
      "read_conversation",
      "search_conversations",
    ],
  },
  {
    id: "memory",
    label: "Memory",
    tools: ["memory"],
  },
  {
    id: "skills",
    label: "Skills",
    tools: ["skill"],
  },
  {
    id: "automation",
    label: "Automation & Triggers",
    tools: ["schedule"],
  },
  {
    id: "git",
    label: "Git & Worktrees",
    tools: ["switch_branch", "create_worktree"],
  },
  {
    id: "mcp",
    label: "MCP & Connectors",
    tools: ["call_mcp_tool", "refresh_mcp_servers"],
  },
  {
    id: "orchestration",
    label: "Orchestration",
    tools: [
      "orchestration_board_snapshot",
      "orchestration_create_issue",
      "orchestration_update_issue",
      "orchestration_comment_issue",
      "orchestration_delete_issue",
      "orchestration_assign_agent",
      "orchestration_update_agent_permissions",
      "orchestration_control_agent",
      "orchestration_read_agent_transcript",
      "orchestration_wait",
    ],
  },
  {
    id: "subagents",
    label: "Subagents",
    tools: [
      "subagent",
      "read_subagent_transcript",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
    ],
  },
];

export const CESIUM_KNOWN_PROFILE_TOOLS: ReadonlySet<string> = new Set(
  CESIUM_PROFILE_TOOL_GROUPS.flatMap((group) => group.tools)
);

const MAX_PROFILE_INSTRUCTIONS_CHARS = 8_000;
const MAX_PROFILE_NAME_CHARS = 60;
const MAX_PROFILE_DESCRIPTION_CHARS = 240;
const MAX_CUSTOM_PROFILES = 32;

const WORK_PROFILE_ALLOWED_TOOLS: string[] = [
  // Locked core tools are implicit but listed for the editor UI.
  ...CESIUM_PROFILE_LOCKED_TOOLS,
  // Documents/artifact edits stay possible; guidance steers toward artifacts.
  "write_file",
  "edit_file",
  // Knowledge plane.
  "search_history",
  "read_history_page",
  "list_conversations",
  "read_conversation",
  "search_conversations",
  "memory",
  // Self-improvement and proactivity (Hermes parity).
  "skill",
  "schedule",
  // Planning and durable execution.
  "create_plan",
  "update_plan",
  "read_plan",
  "finalize_plan",
  "goal_set",
  "goal_pause",
  "goal_block",
  "goal_summarize",
  "goal_complete",
  "workflow_run",
  "workflow_status",
  "workflow_await",
  // Connectors: browser, artifacts, phone, and user MCP servers.
  "call_mcp_tool",
  "refresh_mcp_servers",
  // Delegation.
  "subagent",
  "read_subagent_transcript",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  // Kanban management.
  "orchestration_board_snapshot",
  "orchestration_create_issue",
  "orchestration_update_issue",
  "orchestration_comment_issue",
  "orchestration_delete_issue",
  "orchestration_assign_agent",
  "orchestration_update_agent_permissions",
  "orchestration_control_agent",
  "orchestration_read_agent_transcript",
  "orchestration_wait",
];

export const CESIUM_CODE_PROFILE: CesiumAgentProfile = {
  id: "code",
  name: "Code",
  description:
    "Full software-engineering envelope: files, terminal, git/worktrees, and every harness tool.",
  builtIn: true,
  prompt: { base: "code", customInstructions: "" },
  tools: { allowed: "all", mcpServers: "all" },
  permissionOverrides: {},
};

export const CESIUM_WORK_PROFILE: CesiumAgentProfile = {
  id: "work",
  name: "Work",
  description:
    "General-work envelope: research, browser, connectors, artifacts, memory, and delegation - no terminal or git by default.",
  builtIn: true,
  prompt: { base: "work", customInstructions: "" },
  tools: { allowed: WORK_PROFILE_ALLOWED_TOOLS, mcpServers: "all" },
  permissionOverrides: { terminal: "deny" },
};

export const CESIUM_BUILTIN_PROFILES: readonly CesiumAgentProfile[] = [
  CESIUM_CODE_PROFILE,
  CESIUM_WORK_PROFILE,
];

export const CESIUM_DEFAULT_PROFILE_ID = CESIUM_CODE_PROFILE.id;

/**
 * First-install visibility for built-in profiles. Work stays in the catalog so
 * it can be flipped on in Settings, but it is not offered in the new-chat
 * toggle until the user enables it. Custom profiles default to visible.
 */
export const CESIUM_DEFAULT_ENABLED_PROFILES: Readonly<Record<string, boolean>> = {
  [CESIUM_CODE_PROFILE.id]: true,
  [CESIUM_WORK_PROFILE.id]: false,
};

export function defaultEnabledFlagForProfileId(profileId: string): boolean {
  return CESIUM_DEFAULT_ENABLED_PROFILES[profileId] ?? true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPromptBase(value: unknown): value is CesiumProfilePromptBase {
  return value === "code" || value === "work" || value === "minimal";
}

function isPermissionOverride(value: unknown): value is CesiumProfilePermissionOverride {
  return value === "ask" || value === "allow" || value === "deny";
}

const PERMISSION_OVERRIDE_CATEGORIES: readonly AgentPermissionCategory[] = [
  "editFile",
  "terminal",
  "mcpCall",
  "switchMode",
];

function normalizeToolAllowlist(
  raw: unknown,
  additionalKnownTools: ReadonlySet<string>
): "all" | string[] {
  if (raw === "all") {
    return "all";
  }
  if (!Array.isArray(raw)) {
    return "all";
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = asTrimmedString(entry);
    if (
      name &&
      (CESIUM_KNOWN_PROFILE_TOOLS.has(name) || additionalKnownTools.has(name))
    ) {
      seen.add(name);
    }
  }
  for (const locked of CESIUM_PROFILE_LOCKED_TOOLS) {
    seen.add(locked);
  }
  return [...seen];
}

function normalizeMcpServerAllowlist(raw: unknown): "all" | string[] {
  if (raw === "all" || !Array.isArray(raw)) {
    return "all";
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = asTrimmedString(entry);
    if (id) {
      seen.add(id.toLowerCase());
    }
  }
  return [...seen];
}

/**
 * Normalize one persisted custom profile. Returns null when the record is
 * unusable (missing id/name or shadowing a built-in id).
 */
export function normalizeCesiumProfile(
  raw: unknown,
  additionalKnownTools: readonly string[] = []
): CesiumAgentProfile | null {
  const record = asRecord(raw);
  const id = asTrimmedString(record?.id);
  const name = asTrimmedString(record?.name);
  if (!record || !id || !name) {
    return null;
  }
  if (CESIUM_BUILTIN_PROFILES.some((profile) => profile.id === id)) {
    return null;
  }
  const prompt = asRecord(record.prompt);
  const tools = asRecord(record.tools);
  const overridesRaw = asRecord(record.permissionOverrides);
  const permissionOverrides: CesiumAgentProfile["permissionOverrides"] = {};
  for (const category of PERMISSION_OVERRIDE_CATEGORIES) {
    const value = overridesRaw?.[category];
    if (isPermissionOverride(value)) {
      permissionOverrides[category] = value;
    }
  }
  const rawInstructions =
    typeof prompt?.customInstructions === "string" ? prompt.customInstructions : "";
  return {
    id,
    name: name.slice(0, MAX_PROFILE_NAME_CHARS),
    description: (asTrimmedString(record.description) ?? "").slice(
      0,
      MAX_PROFILE_DESCRIPTION_CHARS
    ),
    builtIn: false,
    prompt: {
      base: isPromptBase(prompt?.base) ? prompt.base : "minimal",
      customInstructions: rawInstructions.slice(0, MAX_PROFILE_INSTRUCTIONS_CHARS),
    },
    tools: {
      allowed: normalizeToolAllowlist(tools?.allowed, new Set(additionalKnownTools)),
      mcpServers: normalizeMcpServerAllowlist(tools?.mcpServers),
    },
    permissionOverrides,
  };
}

export function normalizeCesiumProfiles(
  raw: unknown,
  additionalKnownTools: readonly string[] = []
): CesiumAgentProfile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seenIds = new Set<string>();
  const profiles: CesiumAgentProfile[] = [];
  for (const entry of raw) {
    const profile = normalizeCesiumProfile(entry, additionalKnownTools);
    if (!profile || seenIds.has(profile.id)) {
      continue;
    }
    seenIds.add(profile.id);
    profiles.push(profile);
    if (profiles.length >= MAX_CUSTOM_PROFILES) {
      break;
    }
  }
  return profiles;
}

/** Built-ins first, then custom profiles, for pickers and editors. */
export function listCesiumProfileCatalog(
  customProfiles: CesiumAgentProfile[]
): CesiumAgentProfile[] {
  return [...CESIUM_BUILTIN_PROFILES, ...customProfiles];
}

/**
 * Normalize the persisted enable map.
 *
 * A missing map is treated as legacy-all-on so existing installs keep seeing
 * Code + Work. A present map uses explicit booleans, then first-install
 * defaults for omitted built-ins (Work off) and `true` for custom ids.
 */
export function normalizeCesiumEnabledProfiles(
  raw: unknown,
  customProfiles: CesiumAgentProfile[]
): Record<string, boolean> {
  const catalog = listCesiumProfileCatalog(customProfiles);
  const record = asRecord(raw);
  const enabled: Record<string, boolean> = {};
  const legacyAllOn = record == null;
  for (const profile of catalog) {
    if (typeof record?.[profile.id] === "boolean") {
      enabled[profile.id] = record[profile.id] as boolean;
    } else if (legacyAllOn) {
      enabled[profile.id] = true;
    } else {
      enabled[profile.id] = defaultEnabledFlagForProfileId(profile.id);
    }
  }
  if (!Object.values(enabled).some(Boolean)) {
    enabled[CESIUM_DEFAULT_PROFILE_ID] = true;
  }
  return enabled;
}

export function listCesiumEnabledProfiles(
  customProfiles: CesiumAgentProfile[],
  enabledProfiles: Record<string, boolean>
): CesiumAgentProfile[] {
  return listCesiumProfileCatalog(customProfiles).filter(
    (profile) => enabledProfiles[profile.id] !== false
  );
}

export function normalizeCesiumDefaultProfileId(
  raw: unknown,
  customProfiles: CesiumAgentProfile[],
  enabledProfiles?: Record<string, boolean>
): string {
  const catalog = enabledProfiles
    ? listCesiumEnabledProfiles(customProfiles, enabledProfiles)
    : listCesiumProfileCatalog(customProfiles);
  const id = asTrimmedString(raw);
  if (id && catalog.some((profile) => profile.id === id)) {
    return id;
  }
  return catalog[0]?.id ?? CESIUM_DEFAULT_PROFILE_ID;
}

/** Resolve the active profile, falling back to the default and then Code. */
export function resolveCesiumProfile(input: {
  profileId?: string | null;
  customProfiles: CesiumAgentProfile[];
  defaultProfileId?: string | null;
}): CesiumAgentProfile {
  const catalog = listCesiumProfileCatalog(input.customProfiles);
  const requested = input.profileId?.trim();
  if (requested) {
    const match = catalog.find((profile) => profile.id === requested);
    if (match) {
      return match;
    }
  }
  const fallback = input.defaultProfileId?.trim();
  if (fallback) {
    const match = catalog.find((profile) => profile.id === fallback);
    if (match) {
      return match;
    }
  }
  return CESIUM_CODE_PROFILE;
}

function toolFamilyAllowed(name: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(name)) {
    return true;
  }
  // Legacy/auxiliary names within a family (e.g. goal_get, goal_resume) follow
  // the family's canonical tools instead of requiring their own entries.
  if (isGoalToolName(name)) {
    return allowed.has("goal_set");
  }
  if (isWorkflowToolName(name)) {
    return allowed.has("workflow_run");
  }
  if (isOrchestrationToolName(name)) {
    return allowed.has("orchestration_board_snapshot");
  }
  return false;
}

function profileBlock(
  name: string,
  profile: CesiumAgentProfile,
  detail: string
): CesiumProfileToolPolicyDecision {
  return {
    allowed: false,
    reason:
      `Tool ${name} is not part of the active "${profile.name}" agent profile. ${detail} ` +
      "Continue within the profile's tool surface, or ask the user to switch profiles " +
      "(composer profile picker) or edit the profile under Settings → Agents → Cesium Agent.",
  };
}

/**
 * Hard capability boundary for the active profile, layered before mode policy.
 * Direct browser_* tool names (subagents) are policy-equivalent to calling the
 * built-in browser MCP server through call_mcp_tool.
 */
export function resolveCesiumProfileToolPolicy(input: {
  profile: CesiumAgentProfile;
  toolName: string;
  arguments?: Record<string, unknown>;
}): CesiumProfileToolPolicyDecision {
  const profile = input.profile;
  const rawName = normalizeCesiumToolName(input.toolName);
  const isBrowserTool = rawName.startsWith("browser_");
  const name = isBrowserTool ? "call_mcp_tool" : rawName;

  if (name === "switch_mode" || CESIUM_PROFILE_LOCKED_TOOLS.includes(name)) {
    return { allowed: true };
  }

  if (profile.tools.allowed !== "all") {
    const allowed = new Set(profile.tools.allowed);
    if (!toolFamilyAllowed(name, allowed)) {
      return profileBlock(
        rawName,
        profile,
        "The profile's tool allowlist does not include it."
      );
    }
  }

  if (name === "call_mcp_tool" && profile.tools.mcpServers !== "all") {
    const serverId = isBrowserTool
      ? "browser"
      : asTrimmedString(input.arguments?.serverId)?.toLowerCase();
    if (serverId && !profile.tools.mcpServers.includes(serverId)) {
      return profileBlock(
        rawName,
        profile,
        `MCP server "${serverId}" is not in the profile's server allowlist (${profile.tools.mcpServers.join(", ") || "empty"}).`
      );
    }
  }

  return { allowed: true };
}

/**
 * Filter the advertised tool schemas to the profile envelope. Locked core
 * tools always survive; unlike mode policy, excluded schemas are hidden from
 * the model entirely.
 */
export function filterCesiumToolsForProfile(
  tools: CesiumToolDefinition[],
  profile: CesiumAgentProfile
): CesiumToolDefinition[] {
  if (profile.tools.allowed === "all") {
    return tools;
  }
  const allowed = new Set(profile.tools.allowed);
  return tools.filter(
    (tool) =>
      CESIUM_PROFILE_LOCKED_TOOLS.includes(tool.name) ||
      toolFamilyAllowed(normalizeCesiumToolName(tool.name), allowed)
  );
}

/**
 * Known tools the profile excludes from its envelope (locked tools never
 * appear). Empty for "all" profiles.
 */
export function listCesiumProfileExcludedTools(profile: CesiumAgentProfile): string[] {
  if (profile.tools.allowed === "all") {
    return [];
  }
  const allowed = new Set(profile.tools.allowed);
  return CESIUM_PROFILE_TOOL_GROUPS.flatMap((group) =>
    group.tools.filter(
      (tool) => !allowed.has(tool) && !CESIUM_PROFILE_LOCKED_TOOLS.includes(tool)
    )
  );
}

/** Compact single-line surface summary for reminders and switch confirmations. */
export function summarizeCesiumProfileToolSurface(profile: CesiumAgentProfile): string {
  if (profile.tools.allowed === "all") {
    const mcp =
      profile.tools.mcpServers === "all"
        ? "all MCP servers"
        : `MCP servers: ${profile.tools.mcpServers.join(", ") || "none"}`;
    return `All harness tools are available (${mcp}).`;
  }
  const allowed = new Set(profile.tools.allowed);
  const groups = CESIUM_PROFILE_TOOL_GROUPS.filter((group) =>
    group.tools.some((tool) => allowed.has(tool))
  ).map((group) => group.label);
  const excluded = listCesiumProfileExcludedTools(profile);
  const mcp =
    profile.tools.mcpServers === "all"
      ? "all MCP servers"
      : `MCP servers limited to: ${profile.tools.mcpServers.join(", ") || "none"}`;
  return [
    `Available tool groups: ${groups.join(", ") || "core only"} (${mcp}).`,
    excluded.length > 0 ? `Unavailable tools: ${excluded.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
