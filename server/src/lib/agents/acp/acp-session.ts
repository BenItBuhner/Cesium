import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AcpJsonRpcError, AcpStdioClient } from "../acp-transport.js";
import {
  acpSessionInitialToolCallKey,
  acpSessionToolUpdateKey,
} from "../acp-session-tool-dedup.js";
import {
  type AcpSharedBridge,
  makeAcpPoolKey,
  retainAcpSharedBridge,
} from "../acp-shared-bridge.js";
import { normalizeOpenCodeToolKey } from "../opencode-global-sse.js";
import { extractToolEditPreview } from "../tool-edit-preview.js";
import {
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "../config-option-utils.js";
import {
  formatFindToolTitle,
  formatGrepToolTitle,
  formatReadToolTitle,
} from "../tool-display-labels.js";
import { writeAgentBackendConfigCache } from "../provider-cache-store.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../../plugins/attachments.js";
import {
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../../global-settings-store.js";
import { extractInlineReasoning } from "../parse-inline-reasoning.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentToolCallStatus,
} from "../types.js";
import {
  LEGACY_MODE_CONFIG_ID,
  LEGACY_MODEL_CONFIG_ID,
  mergeSessionConfigOptions,
  normalizeConversationModeForProvider,
  normalizeProviderMode,
  parseConfigOptions,
  parseConfigOptionString,
  parseLegacySessionConfigOptions,
} from "../config-option-parse.js";
import {
  buildCursorPromptToolHints,
  countUniqueLocationPaths,
  inferCursorReadPathFromContent,
  inferCursorSearchLocations,
  isGenericCursorSearchTitle,
  type CursorPromptToolHints,
  type CursorToolInference,
} from "../cursor-prompt-inference.js";
import {
  buildFallbackPermissionOptions,
  buildPermissionToolSignature,
  extractAcpEditPreview,
  extractAcpToolCallPayload,
  extractPermissionRequestDetail,
  inferAcpToolKindFromEntry,
  isGenericAcpToolTitle,
  mergeScavengedAcpLocations,
  namespaceOpenCodeSseToolCallId,
  normalizeAcpSessionUpdateKind,
  normalizeAcpToolCallStatus,
  normalizeToolCallId,
  parseLooseJsonObjectForAcp,
  parsePermissionOptions,
  permissionDecisionFromKind,
  providerOptionIdForPermissionSelection,
  providerOptionIdForRememberedPermission,
  readOpenCodeSseChildSessionId,
  summarizeAcpToolCallDetail,
  summarizeAcpToolCallTitle,
  withPersistentPermissionOptions,
} from "./acp-tool-parse.js";

function tryParseJsonArrayString(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** ACP `plan` updates vary by server: `entries`, `todos`, stringified JSON, or nested under `data`. */
function parseTodoLikeArrayFromPlanRecord(record: Record<string, unknown>): unknown[] | undefined {
  const fromData =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  return (
    tryParseJsonArrayString(record.entries) ??
    tryParseJsonArrayString(record.todos) ??
    tryParseJsonArrayString(record.items) ??
    (fromData
      ? tryParseJsonArrayString(fromData.entries) ??
        tryParseJsonArrayString(fromData.todos) ??
        tryParseJsonArrayString(fromData.items)
      : undefined)
  );
}

function agentPlanEntriesFromTodoLikeList(
  list: unknown[] | undefined,
  conversationId: string,
  idPrefix: string
): AgentPlanEntry[] {
  if (!list?.length) {
    return [];
  }
  const entries: AgentPlanEntry[] = [];
  for (const [index, todo] of list.entries()) {
    if (!todo || typeof todo !== "object") {
      continue;
    }
    const todoRecord = todo as Record<string, unknown>;
    const content =
      typeof todoRecord.content === "string"
        ? todoRecord.content
        : typeof todoRecord.text === "string"
          ? todoRecord.text
          : typeof todoRecord.title === "string"
            ? todoRecord.title
            : "";
    const status =
      todoRecord.status === "pending" ||
      todoRecord.status === "in_progress" ||
      todoRecord.status === "blocked" ||
      todoRecord.status === "completed"
        ? todoRecord.status
        : "pending";
    const trimmed = content.trim();
    if (!trimmed) {
      continue;
    }
    entries.push({
      id:
        typeof todoRecord.id === "string"
          ? todoRecord.id
          : `${conversationId}-${idPrefix}-${index}`,
      content: trimmed,
      priority:
        typeof todoRecord.priority === "string" ? todoRecord.priority : undefined,
      status,
    });
  }
  return entries;
}

function isOpenCodeGlobalSseParams(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const meta = (params as Record<string, unknown>)._meta;
  return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>).openCodeSse === true);
}

function openCodeTodoArrayFromToolRecord(record: Record<string, unknown>): unknown[] | undefined {
  const input = parseLooseJsonObjectForAcp(record.rawInput) ?? parseLooseJsonObjectForAcp(record.raw_input);
  const output = parseLooseJsonObjectForAcp(record.rawOutput) ?? parseLooseJsonObjectForAcp(record.raw_output);
  const pick = (obj: Record<string, unknown> | undefined): unknown[] | undefined => {
    if (!obj) {
      return undefined;
    }
    return (
      tryParseJsonArrayString(obj.todos) ??
      tryParseJsonArrayString(obj.items) ??
      (Array.isArray(obj.list) ? (obj.list as unknown[]) : undefined)
    );
  };
  return pick(input) ?? pick(output);
}

function shouldMirrorOpenCodeTodoToolToPlan(
  params: unknown,
  record: Record<string, unknown>,
  toolKind: string,
  status: string,
  title: string | undefined
): boolean {
  if (status !== "completed") {
    return false;
  }
  if (!isOpenCodeGlobalSseParams(params)) {
    return false;
  }
  if (toolKind === "todo") {
    return true;
  }
  const rawTitle = typeof record.title === "string" ? record.title : title;
  const k = normalizeOpenCodeToolKey(rawTitle ?? "");
  if (k === "todowrite" || k === "todoread") {
    return true;
  }
  if (k.startsWith("todo") && (k.includes("read") || k.includes("write") || k.includes("update"))) {
    return true;
  }
  return false;
}

async function appendOpenCodeTodoPlanIfNeeded(
  callbacks: AgentRuntimeCallbacks,
  params: unknown,
  record: Record<string, unknown>,
  toolKind: string,
  status: string,
  title: string | undefined
): Promise<void> {
  if (!shouldMirrorOpenCodeTodoToolToPlan(params, record, toolKind, status, title)) {
    return;
  }
  const list = openCodeTodoArrayFromToolRecord(record);
  if (!list?.length) {
    return;
  }
  const entries = agentPlanEntriesFromTodoLikeList(list, callbacks.conversation.id, "todo");
  if (entries.length === 0) {
    return;
  }
  await callbacks.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: callbacks.conversation.id,
      kind: "plan",
      planId: `${callbacks.conversation.id}-todos`,
      entries,
      raw: params,
    },
  ]);
}

/**
 * Declares what the Cesium Node client can delegate when the agent asks.
 * Defaults are conservative. For headless / CI, Cursor may require overrides —
 * set `OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON` (partial JSON merged on top).
 */
function buildAcpClientCapabilities(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    promptCapabilities: { image: true },
  };
  const raw = process.env.OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON?.trim();
  if (!raw) {
    return base;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }
    const p = parsed as Record<string, unknown>;
    const next: Record<string, unknown> = { ...base, ...p };
    if (p.fs && typeof p.fs === "object" && !Array.isArray(p.fs)) {
      next.fs = {
        ...(base.fs as Record<string, unknown>),
        ...(p.fs as Record<string, unknown>),
      };
    }
    return next;
  } catch {
    return base;
  }
}

function summarizeAuthenticateResult(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  for (const key of [
    "message",
    "instructions",
    "detail",
    "url",
    "loginUrl",
    "verificationUrl",
  ] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      if (key === "url" || key === "loginUrl" || key === "verificationUrl") {
        return `Open or complete: ${t}`;
      }
      return t;
    }
  }
  return undefined;
}

async function runAcpTransportBootstrap(transport: AcpStdioClient): Promise<string[]> {
  const messages: string[] = [];
  const init = (await transport.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: buildAcpClientCapabilities(),
    clientInfo: {
      name: "cesium-server",
      title: "Cesium Server",
      version: "0.1.0",
    },
  })) as Record<string, unknown> | undefined;

  const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
  const seen = new Set<string>();
  for (const entry of authMethods) {
    const id =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? parseConfigOptionString((entry as Record<string, unknown>).id)
        : typeof entry === "string"
          ? entry.trim()
          : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (id === "cursor_login") {
      try {
        const authResult = await transport.request("authenticate", { methodId: "cursor_login" });
        const note = summarizeAuthenticateResult(authResult);
        if (note) {
          messages.push(`Cursor CLI authentication: ${note}`);
        }
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        messages.push(
          `Cursor CLI authentication failed: ${errText}. Sign in on the server host with your Cursor CLI, set OPENCURSOR_CURSOR_CLI_BIN to that binary, and redeploy.`
        );
      }
    } else if (id === "opencode-login") {
      try {
        const authResult = await transport.request("authenticate", { methodId: "opencode-login" });
        const note = summarizeAuthenticateResult(authResult);
        if (note) {
          messages.push(`OpenCode ACP authentication: ${note}`);
        }
      } catch {
        // Auth failed (e.g. not logged in) — silent; the ACP transport itself will
        // surface any action the user needs to take through its normal protocol flow.
      }
    } else {
      messages.push(
        `ACP lists authentication method "${id}". If the agent stalls, complete any login this method requires on the server (TTY or documented OAuth); Cesium only bridges stdio.`
      );
    }
  }
  return messages;
}

function backendUsesAcpPromptHints(backendId: AgentBackendId): boolean {
  return backendId === "gemini-acp";
}

function pluginMcpServersForAcp(
  servers: Record<string, unknown>
): Array<Record<string, unknown>> {
  return Object.entries(servers).map(([name, config]) => ({
    name,
    ...(config && typeof config === "object" ? config : {}),
  }));
}

export class AcpSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;

  private readonly pendingPermissionRequestIds = new Map<string, number | string>();
  private readonly pendingPermissionContextById = new Map<
    string,
    {
      options: AgentPermissionOption[];
      toolKey: string;
      toolLabel: string;
    }
  >();
  private currentAssistantMessageId: string | null = null;
  private disposed = false;
  private readonly bridge: AcpSharedBridge;
  private readonly releaseBridge: () => Promise<void>;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly backend: AgentBackendInfo;
  private readonly seedConfigOptions: AgentConfigOption[] | undefined;
  private suppressedAssistantChunks: string[] | null = null;
  private currentCursorPromptHints: CursorPromptToolHints | null = null;
  private readonly cursorToolInferences = new Map<string, CursorToolInference>();
  /** Drop identical ACP re-broadcasts of the same tool announcement; avoids duplicate DB + WS. */
  private readonly acpInitialToolCallKeys = new Set<string>();
  private readonly acpToolUpdateKeys = new Set<string>();
  private constructor(input: {
    bridge: AcpSharedBridge;
    releaseBridge: () => Promise<void>;
    callbacks: AgentRuntimeCallbacks;
    backend: AgentBackendInfo;
    sessionId: string;
    configOptions: AgentConfigOption[];
    capabilities: AgentProviderCapabilities;
    seedConfigOptions?: AgentConfigOption[];
  }) {
    this.bridge = input.bridge;
    this.releaseBridge = input.releaseBridge;
    this.callbacks = input.callbacks;
    this.backend = input.backend;
    this.sessionId = input.sessionId;
    this.configOptions = input.configOptions;
    this.capabilities = input.capabilities;
    this.seedConfigOptions = input.seedConfigOptions;
    this.registerBridgeHandlers();
  }

  private beginCursorPromptInference(promptText: string): void {
    if (!backendUsesAcpPromptHints(this.backend.id)) {
      return;
    }
    this.currentCursorPromptHints = buildCursorPromptToolHints(
      this.callbacks.workspace.root,
      promptText
    );
    this.cursorToolInferences.clear();
  }

  private endCursorPromptInference(): void {
    this.currentCursorPromptHints = null;
    this.cursorToolInferences.clear();
  }

  private getCursorToolInference(toolCallId: string): CursorToolInference {
    const existing = this.cursorToolInferences.get(toolCallId);
    if (existing) {
      return existing;
    }
    const created: CursorToolInference = {};
    this.cursorToolInferences.set(toolCallId, created);
    return created;
  }

  private assignCursorPromptHints(toolCallId: string, toolKind: string): CursorToolInference {
    const inference = this.getCursorToolInference(toolCallId);
    if (toolKind && toolKind !== "tool" && !inference.toolKind) {
      inference.toolKind = toolKind;
    }
    const promptHints = this.currentCursorPromptHints;
    if (!promptHints) {
      return inference;
    }
    if (
      toolKind === "read" &&
      !inference.path &&
      promptHints.nextPathIndex < promptHints.explicitPaths.length
    ) {
      const hintedPath = promptHints.explicitPaths[promptHints.nextPathIndex++]!;
      inference.path = hintedPath;
      inference.locations = [{ path: hintedPath }];
    }
    if (
      (toolKind === "search" || toolKind === "grep") &&
      !inference.query &&
      promptHints.nextSearchIndex < promptHints.searches.length
    ) {
      const hint = promptHints.searches[promptHints.nextSearchIndex++]!;
      inference.query = hint.query;
      inference.searchPresentation = hint.presentation;
    }
    return inference;
  }

  private async enrichCursorToolCall(input: {
    toolCallId: string;
    toolKind: string;
    title: string | undefined;
    detail: string | undefined;
    locations: { path: string; line?: number }[] | undefined;
    record: Record<string, unknown>;
    status: AgentToolCallStatus;
  }): Promise<{
    toolKind: string;
    title: string | undefined;
    detail: string | undefined;
    locations: { path: string; line?: number }[] | undefined;
  }> {
    if (!backendUsesAcpPromptHints(this.backend.id)) {
      return {
        toolKind: input.toolKind,
        title: input.title,
        detail: input.detail,
        locations: input.locations,
      };
    }

    const next = {
      toolKind: input.toolKind,
      title: input.title,
      detail: input.detail,
      locations: input.locations,
    };
    const inference = this.assignCursorPromptHints(input.toolCallId, next.toolKind);
    if (next.toolKind === "tool" && inference.toolKind) {
      next.toolKind = inference.toolKind;
    }

    if (
      next.toolKind === "read" &&
      input.status === "completed" &&
      (!inference.path || !next.locations?.length)
    ) {
      const rawOutput =
        parseLooseJsonObjectForAcp(input.record.rawOutput) ??
        parseLooseJsonObjectForAcp(input.record.raw_output) ??
        (input.record.rawOutput &&
        typeof input.record.rawOutput === "object" &&
        !Array.isArray(input.record.rawOutput)
          ? (input.record.rawOutput as Record<string, unknown>)
          : undefined);
      const readContent =
        typeof rawOutput?.content === "string"
          ? rawOutput.content
          : typeof rawOutput?.text === "string"
            ? rawOutput.text
            : undefined;
      if (readContent?.trim()) {
        const promptPaths = this.currentCursorPromptHints?.explicitPaths ?? [];
        const matchedPath = await inferCursorReadPathFromContent(
          this.callbacks.workspace.root,
          readContent,
          inference.path ? [inference.path, ...promptPaths] : promptPaths
        );
        if (matchedPath) {
          inference.path = matchedPath;
          inference.locations = [{ path: matchedPath }];
        }
      }
    }

    if (next.toolKind === "read") {
      if ((!next.locations || next.locations.length === 0) && inference.locations?.length) {
        next.locations = inference.locations;
      }
      if ((!next.locations || next.locations.length === 0) && inference.path) {
        next.locations = [{ path: inference.path }];
      }
      if (
        (isGenericAcpToolTitle(next.title) || next.title === "Read file" || next.title === "Tool call") &&
        inference.path
      ) {
        next.title = formatReadToolTitle(inference.path);
      }
    }

    if (next.toolKind === "search" || next.toolKind === "grep") {
      if (
        input.status === "completed" &&
        inference.query &&
        (!inference.locations || inference.locations.length === 0)
      ) {
        const locations = await inferCursorSearchLocations(
          this.callbacks.workspace.root,
          inference.query
        );
        if (locations.length > 0) {
          inference.locations = locations;
          const uniqueFiles = countUniqueLocationPaths(locations);
          inference.detail = `${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"} matched`;
        }
      }
      if ((!next.locations || next.locations.length === 0) && inference.locations?.length) {
        next.locations = inference.locations;
      }
      if (!next.detail && inference.detail) {
        next.detail = inference.detail;
      }
      if (isGenericCursorSearchTitle(next.title) && inference.query) {
        next.title =
          inference.searchPresentation === "grep"
            ? formatGrepToolTitle(inference.query)
            : formatFindToolTitle(inference.query);
      }
    }

    return next;
  }

  static async create(input: {
    backend: AgentBackendInfo;
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    callbacks: AgentRuntimeCallbacks;
    loadSessionId?: string | null;
    seedConfigOptions?: AgentConfigOption[];
  }): Promise<AcpSessionHandle> {
    const command = input.command;
    const args = input.args;
    const env = input.env ?? process.env;

    const poolKey = makeAcpPoolKey({
      workspaceRoot: input.callbacks.workspace.root,
      backendId: input.backend.id,
      command,
      args,
    });
    const { bridge, release, bootstrapSystemMessages } = await retainAcpSharedBridge({
      poolKey,
      spawn: () =>
        AcpStdioClient.spawn({
          command,
          args,
          cwd: input.callbacks.workspace.root,
          env,
          processName: `Cesium Agent - ${input.backend.label}`,
        }),
      afterSpawn: (transport) => runAcpTransportBootstrap(transport),
    });

    const isInvalidParamsError = (error: unknown): boolean => {
      if (error instanceof AcpJsonRpcError) {
        // JSON-RPC: -32602 = Invalid params
        return error.code === -32602;
      }
      const message = error instanceof Error ? error.message : String(error ?? "");
      return /invalid params?/i.test(message);
    };
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: input.callbacks.workspace.id,
      workspaceRoot: input.callbacks.workspace.root,
      backendId: input.backend.id,
    });
    const acpMcpServers = pluginMcpServersForAcp(pluginAttachments.sdkMcp.servers);

    const tryOpenSession = async (): Promise<Record<string, unknown> | null | undefined> => {
      if (!input.loadSessionId) {
        return (await bridge.request("session/new", {
          cwd: input.callbacks.workspace.root,
          mcpServers: acpMcpServers,
        })) as Record<string, unknown> | null | undefined;
      }

      // IMPORTANT: Cursor's `session/load` param schema is strict. In practice:
      // - `cwd` and `mcpServers` are required
      // - `mcpServers` must be an array (empty is fine)
      //
      // Do NOT "compat" by dropping keys — that produces unrelated -32603 schema errors
      // and makes retries look like random failures.
      const workspaceRoot = input.callbacks.workspace.root;
      let workspaceRootReal = workspaceRoot;
      try {
        workspaceRootReal = await fs.realpath(workspaceRoot);
      } catch {
        // best-effort; keep logical root
      }

      const loadAttempts: Array<Record<string, unknown>> = [
        {
          sessionId: input.loadSessionId,
          cwd: workspaceRoot,
          mcpServers: acpMcpServers,
        },
        ...(workspaceRootReal !== workspaceRoot
          ? [
              {
                sessionId: input.loadSessionId,
                cwd: workspaceRootReal,
                mcpServers: acpMcpServers,
              },
            ]
          : []),
        {
          sessionId: input.loadSessionId,
          cwd: path.resolve(workspaceRoot),
          mcpServers: acpMcpServers,
        },
      ];

      let lastError: unknown;
      for (let index = 0; index < loadAttempts.length; index += 1) {
        try {
          const result = (await bridge.request(
            "session/load",
            loadAttempts[index]
          )) as Record<string, unknown> | null | undefined;
          if (index > 0) {
            await input.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: input.callbacks.conversation.id,
                kind: "system",
                level: "warning",
                text: `Recovered provider session load using compatibility params fallback (attempt ${index + 1}).`,
              },
            ]);
          }
          return result;
        } catch (error) {
          lastError = error;
          if (!isInvalidParamsError(error)) {
            throw error;
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    };

    bridge.startCreationCapture();
    try {
      const openResult = await tryOpenSession();

      const openResultRecord =
        openResult && typeof openResult === "object"
          ? (openResult as Record<string, unknown>)
          : {};

      const sessionId =
        typeof openResultRecord.sessionId === "string"
          ? openResultRecord.sessionId
          : input.loadSessionId;
      if (!sessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }

      const liveConfigOptions = mergeSessionConfigOptions(
        parseConfigOptions(openResultRecord.configOptions),
        parseLegacySessionConfigOptions(openResultRecord)
      );
      const configOptions = liveConfigOptions;

      const handle = new AcpSessionHandle({
        bridge,
        releaseBridge: release,
        callbacks: input.callbacks,
        backend: input.backend,
        sessionId,
        configOptions,
        capabilities: input.backend.capabilities,
        seedConfigOptions: input.seedConfigOptions,
      });

      await input.callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: sessionId,
        configOptions: configOptions.length > 0 ? configOptions : current.configOptions,
        capabilities: input.backend.capabilities,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));

      if (bootstrapSystemMessages.length > 0) {
        await input.callbacks.appendEvents(
          bootstrapSystemMessages.map((text) => ({
            eventId: randomUUID(),
            conversationId: input.callbacks.conversation.id,
            kind: "system" as const,
            level: "info" as const,
            text,
          }))
        );
      }

      if (configOptions.length > 0) {
        await handle.persistConfigOptions(configOptions);
      }
      bridge.endCreationCapture(sessionId, (method, params) => {
        void handle.handleNotification(method, params);
      });
      await handle.applyConversationConfig(input.callbacks.conversation);
      return handle;
    } catch (error) {
      const detail =
        error instanceof AcpJsonRpcError
          ? {
              kind: "acp_jsonrpc_error" as const,
              method: error.method,
              code: error.code,
              message: error.message,
              params: error.params,
              data: error.data,
            }
          : {
              kind: "unknown_error" as const,
              message: error instanceof Error ? error.message : String(error),
            };
      const headline =
        error instanceof AcpJsonRpcError
          ? `ACP JSON-RPC request failed: ${error.method} (${error.code})`
          : "ACP session initialization failed.";

      await input.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: input.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: headline,
          raw: detail,
        },
      ]);
      bridge.cancelCreationCapture();
      await release();
      throw error;
    }
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    const assistantMessageId = randomUUID();
    this.currentAssistantMessageId = assistantMessageId;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));
    this.beginCursorPromptInference(input.text);

    try {
      const promptContent: Record<string, unknown>[] = [];
      if (input.attachments && input.attachments.length > 0) {
        for (const attachment of input.attachments) {
          promptContent.push({
            type: "image",
            mimeType: attachment.mimeType,
            data: attachment.data,
          });
        }
      }
      if (input.text.trim()) {
        const pluginAttachments = await resolveAgentPluginAttachments({
          workspaceId: this.callbacks.workspace.id,
          workspaceRoot: this.callbacks.workspace.root,
          backendId: this.backend.id,
        });
        promptContent.push({
          type: "text",
          text: appendAgentPluginPrompt(input.text, pluginAttachments),
        });
      }

      const result = (await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: input.userMessageId,
        prompt: promptContent,
      })) as Record<string, unknown> | undefined;

      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason:
            typeof result?.stopReason === "string"
              ? result.stopReason
              : undefined,
          raw: result,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail:
            typeof result?.stopReason === "string"
              ? `Stop reason: ${result.stopReason}`
              : undefined,
        },
      ]);

      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
      this.endCursorPromptInference();
      this.currentAssistantMessageId = null;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ACP prompt failed.";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: message,
      }));
      this.endCursorPromptInference();
      this.currentAssistantMessageId = null;
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.bridge.notify("session/cancel", { sessionId: this.sessionId });
    for (const requestId of this.pendingPermissionRequestIds.values()) {
      this.bridge.respond(requestId, {
        outcome: {
          outcome: "cancelled",
        },
      });
    }
    this.pendingPermissionRequestIds.clear();
    this.pendingPermissionContextById.clear();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Prompt turn cancelled by the client.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (configId === LEGACY_MODE_CONFIG_ID) {
      await this.bridge.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    if (configId === LEGACY_MODEL_CONFIG_ID) {
      await this.bridge.request("session/set_model", {
        sessionId: this.sessionId,
        modelId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    const result = (await this.bridge.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    })) as Record<string, unknown> | undefined;
    const parsed = mergeSessionConfigOptions(
      parseConfigOptions(result?.configOptions),
      parseLegacySessionConfigOptions(result ?? {})
    );
    if (parsed.length > 0) {
      await this.persistConfigOptions(parsed);
      return;
    }
    this.configOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const rawId = this.pendingPermissionRequestIds.get(input.requestId);
    if (rawId === undefined) {
      throw new Error(`Unknown pending permission request: ${input.requestId}`);
    }
    const context = this.pendingPermissionContextById.get(input.requestId);
    const selected = context?.options.find((option) => option.optionId === input.optionId);
    const providerOptionId = providerOptionIdForPermissionSelection(
      context?.options ?? [],
      input.optionId
    );
    this.bridge.respond(rawId, {
      outcome: input.cancelled
        ? { outcome: "cancelled" }
        : {
            outcome: "selected",
            optionId: providerOptionId,
          },
    });
    this.pendingPermissionRequestIds.delete(input.requestId);
    this.pendingPermissionContextById.delete(input.requestId);
    if (
      !input.cancelled &&
      context &&
      selected &&
      (selected.kind === "allow_always" || selected.kind === "reject_always")
    ) {
      const decision = permissionDecisionFromKind(selected.kind);
      if (decision) {
        await saveRememberedAgentPermissionRule({
          workspaceId: this.callbacks.workspace.id,
          backendId: this.backend.id,
          toolKey: context.toolKey,
          toolLabel: context.toolLabel,
          decision,
          optionId: selected.optionId,
          optionKind: selected.kind,
        }).catch(() => undefined);
      }
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingPermissionContextById.clear();
    this.bridge.unregister(this.sessionId);
    await this.releaseBridge();
  }

  private async persistConfigOptions(
    nextConfigOptions: AgentConfigOption[]
  ): Promise<void> {
    if (nextConfigOptions.length === 0) {
      return;
    }
    let persistedConfigOptions = nextConfigOptions;
    await this.callbacks.updateConversation((current) => {
      persistedConfigOptions = nextConfigOptions;
      this.configOptions = persistedConfigOptions;
      const modeOption = findPrimaryModeConfigOption(persistedConfigOptions);
      const modelOption = findPrimaryModelConfigOption(persistedConfigOptions);
      const modelId = modelOption?.currentValue || current.config.modelId;
      const modelName =
        modelOption?.options.find((option) => option.value === modelId)?.name ??
        current.config.modelName;
      return {
        ...current,
        configOptions: persistedConfigOptions,
        config: {
          ...current.config,
          mode: normalizeProviderMode(modeOption?.currentValue, current.config.mode),
          modelId,
          modelName,
        },
      };
    });
    await writeAgentBackendConfigCache(this.backend.id, persistedConfigOptions);
  }

  private async runCursorModelSlashCommand(modelId: string): Promise<void> {
    if (this.suppressedAssistantChunks) {
      throw new Error("Cursor model switch already in progress.");
    }
    this.suppressedAssistantChunks = [];
    try {
      await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: `cursor-model-${randomUUID()}`,
        prompt: [{ type: "text", text: `/model ${modelId}` }],
      });
      const responseText = this.suppressedAssistantChunks.join("").trim();
      if (responseText && /unknown model|invalid model|not found|failed/i.test(responseText)) {
        throw new Error(responseText);
      }
    } finally {
      this.suppressedAssistantChunks = null;
    }
  }

  private registerBridgeHandlers(): void {
    this.bridge.register(this.sessionId, {
      onNotification: (method, params) => {
        void this.handleNotification(method, params);
      },
      onRequest: (id, method, params) => {
        void this.handleRequest(id, method, params);
      },
      onStderr: (line) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `[${this.backend.label}] ${line}`,
          },
        ]);
      },
      onExit: (code) => {
        if (this.disposed) {
          return;
        }
        this.callbacks.markRuntimeStale?.();
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "interrupted",
            detail: `ACP process exited${code == null ? "" : ` with code ${code}`}.`,
            raw: {
              kind: "acp_process_exit",
              code,
            },
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `ACP transport exited${code == null ? "" : ` (code ${code})`}. Clearing stored provider session id to avoid retrying a stale ACP session handle.`,
            raw: { kind: "acp_stale_session_handle", exitCode: code },
          },
        ]);
        void this.callbacks.updateConversation((current) => ({
          ...current,
          providerSessionId: null,
          // Config options are tied to a live ACP session; a dead transport invalidates them.
          configOptions: [],
          lastError: null,
          status:
            current.status === "running" || current.status === "awaiting_permission"
              ? "interrupted"
              : current.status,
        }));
      },
    });
  }

  private async applyConversationConfig(
    conversation: AgentConversationRecord
  ): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(this.configOptions);
    const modelOption = findPrimaryModelConfigOption(this.configOptions);

    const nextModeValue = normalizeConversationModeForProvider(
      conversation.config.mode,
      modeOption
    );
    if (modeOption && nextModeValue && modeOption.currentValue !== nextModeValue) {
      await this.setConfigOption(modeOption.id, nextModeValue);
    }

    if (
      modelOption &&
      modelOption.options.some(
        (option) =>
          option.value === conversation.config.modelId ||
          option.name === conversation.config.modelName
      )
    ) {
      const modelValue =
        modelOption.options.find(
          (option) => option.value === conversation.config.modelId
        )?.value ??
        modelOption.options.find(
          (option) => option.name === conversation.config.modelName
        )?.value;
      if (modelValue && modelOption.currentValue !== modelValue) {
        await this.setConfigOption(modelOption.id, modelValue);
      }
    }
  }

  private trimAcpDedupSet(s: Set<string>, cap: number) {
    if (s.size < cap) {
      return;
    }
    const chunk = 900;
    let removed = 0;
    for (const k of s) {
      s.delete(k);
      removed += 1;
      if (removed >= chunk) {
        break;
      }
    }
  }

  private shouldAppendNewAcpInitialTool(
    toolCallId: string,
    record: Record<string, unknown>,
    params: unknown
  ): boolean {
    const key = acpSessionInitialToolCallKey(toolCallId, record, params);
    if (this.acpInitialToolCallKeys.has(key)) {
      return false;
    }
    this.trimAcpDedupSet(this.acpInitialToolCallKeys, 5000);
    this.acpInitialToolCallKeys.add(key);
    return true;
  }

  private shouldAppendNewAcpToolUpdate(
    toolCallId: string,
    record: Record<string, unknown>,
    params: unknown,
    status: string
  ): boolean {
    const key = acpSessionToolUpdateKey(toolCallId, record, params, status);
    if (this.acpToolUpdateKeys.has(key)) {
      return false;
    }
    this.trimAcpDedupSet(this.acpToolUpdateKeys, 8000);
    this.acpToolUpdateKeys.add(key);
    return true;
  }

  private async handleNotification(
    method: string,
    params: unknown
  ): Promise<void> {
    if (method !== "session/update") {
      return;
    }
    const paramsRecord = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
    const update = paramsRecord?.update;
    if (!update || typeof update !== "object") {
      return;
    }
    const record = update as Record<string, unknown>;
    const sessionUpdate = normalizeAcpSessionUpdateKind(record);
    if (typeof sessionUpdate !== "string") {
      return;
    }
    const sseChildSessionId = readOpenCodeSseChildSessionId(params);
    const sseChildToolMeta =
      sseChildSessionId != null
        ? { openCodeSubagentSessionId: sseChildSessionId }
        : undefined;

    switch (sessionUpdate) {
 case "agent_message_chunk": {
 const text =
 record.content &&
 typeof record.content === "object" &&
 typeof (record.content as Record<string, unknown>).text === "string"
 ? ((record.content as Record<string, unknown>).text as string)
 : null;
 if (!text) {
 return;
 }
 if (this.suppressedAssistantChunks) {
 this.suppressedAssistantChunks.push(text);
 return;
 }
 if (!this.currentAssistantMessageId) {
 return;
 }
 if (this.capabilities.supportsInlineReasoning) {
 const { reasoning, text: cleaned } = extractInlineReasoning(text, {
 normalizeEdges: false,
 });
 if (reasoning.length > 0) {
 await this.callbacks.appendEvents(
 reasoning.map((block) => ({
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "reasoning" as const,
 messageId: this.currentAssistantMessageId!,
 text: block.text,
 raw: block.raw,
 }))
 );
 }
 if (cleaned) {
 await this.callbacks.appendEvents([
 {
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "assistant_message_chunk",
 messageId: this.currentAssistantMessageId,
 text: cleaned,
 raw: params,
 },
 ]);
 }
 return;
 }
 await this.callbacks.appendEvents([
 {
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "assistant_message_chunk",
 messageId: this.currentAssistantMessageId,
 text,
 raw: params,
 },
 ]);
 return;
 }
      case "tool_call": {
        const normalizedStatus = normalizeAcpToolCallStatus(record, "pending");
        const toolCallId = namespaceOpenCodeSseToolCallId(
          normalizeToolCallId(record),
          sseChildSessionId
        );
        let detail = summarizeAcpToolCallDetail(record);
        let locations = mergeScavengedAcpLocations(record);
        let title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record) ?? "Tool call";
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        const enriched = await this.enrichCursorToolCall({
          toolCallId,
          toolKind,
          title,
          detail,
          locations,
          record,
          status: normalizedStatus,
        });
        title = enriched.title ?? title;
        detail = enriched.detail ?? detail;
        locations = enriched.locations ?? locations;
        const enrichedToolKind = enriched.toolKind;
        const editPreview =
          extractAcpEditPreview(record, locations?.[0]?.path) ??
          extractToolEditPreview(params, params, locations?.[0]?.path);
        if (editPreview?.path && !locations?.some((entry) => entry.path === editPreview.path)) {
          locations = [{ path: editPreview.path }, ...(locations ?? [])];
        }
        if (
          enrichedToolKind === "read" &&
          (isGenericAcpToolTitle(title) || title === "Read file") &&
          locations?.[0]?.path
        ) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (record.subtype === "completed") {
          if (
            !this.shouldAppendNewAcpToolUpdate(
              toolCallId,
              record,
              params,
              String(normalizedStatus)
            )
          ) {
            return;
          }
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "tool_call_update",
              toolCallId,
              title,
              toolKind: enrichedToolKind,
              status: normalizedStatus,
              detail,
              locations,
              editPreview,
              raw: params,
              ...sseChildToolMeta,
            },
          ]);
          await appendOpenCodeTodoPlanIfNeeded(
            this.callbacks,
            params,
            record,
            enrichedToolKind,
            normalizedStatus,
            title
          );
          return;
        }
        if (!this.shouldAppendNewAcpInitialTool(toolCallId, record, params)) {
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call",
            toolCallId,
            title,
            toolKind: enrichedToolKind,
            status: normalizedStatus,
            detail,
            locations,
            editPreview,
            raw: params,
            ...sseChildToolMeta,
          },
        ]);
        return;
      }
      case "tool_call_update": {
        const updateToolCallId = namespaceOpenCodeSseToolCallId(
          normalizeToolCallId(record),
          sseChildSessionId
        );
        let locations = mergeScavengedAcpLocations(record);
        let title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record);
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        let detail = summarizeAcpToolCallDetail(record);
        const normalizedStatus = normalizeAcpToolCallStatus(record, "in_progress");
        const enriched = await this.enrichCursorToolCall({
          toolCallId: updateToolCallId,
          toolKind,
          title,
          detail,
          locations,
          record,
          status: normalizedStatus,
        });
        title = enriched.title ?? title;
        detail = enriched.detail ?? detail;
        locations = enriched.locations ?? locations;
        const enrichedToolKind = enriched.toolKind;
        const editPreview =
          extractAcpEditPreview(record, locations?.[0]?.path) ??
          extractToolEditPreview(params, params, locations?.[0]?.path);
        if (editPreview?.path && !locations?.some((entry) => entry.path === editPreview.path)) {
          locations = [{ path: editPreview.path }, ...(locations ?? [])];
        }
        if (
          enrichedToolKind === "read" &&
          title &&
          (isGenericAcpToolTitle(title) || title === "Read file") &&
          locations?.[0]?.path
        ) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (!title && enrichedToolKind === "read" && locations?.[0]?.path) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (
          !this.shouldAppendNewAcpToolUpdate(
            updateToolCallId,
            record,
            params,
            String(normalizedStatus)
          )
        ) {
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: updateToolCallId,
            title,
            toolKind: enrichedToolKind,
            status: normalizedStatus,
            detail,
            locations,
            editPreview,
            raw: params,
            ...sseChildToolMeta,
          },
        ]);
        await appendOpenCodeTodoPlanIfNeeded(
          this.callbacks,
          params,
          record,
          enrichedToolKind,
          normalizedStatus,
          title
        );
        return;
      }
      case "plan": {
        const list = parseTodoLikeArrayFromPlanRecord(record);
        const entries = agentPlanEntriesFromTodoLikeList(
          list,
          this.callbacks.conversation.id,
          "plan"
        );
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "plan",
            planId: `${this.callbacks.conversation.id}-plan`,
            entries,
            raw: params,
          },
        ]);
        return;
      }
      case "config_option_update": {
        const nextConfigOptions = mergeSessionConfigOptions(
          parseConfigOptions(record.configOptions),
          parseLegacySessionConfigOptions(record)
        );
        if (nextConfigOptions.length > 0) {
          await this.persistConfigOptions(nextConfigOptions);
        }
        return;
      }
      case "current_mode_update": {
        const modeId = parseConfigOptionString(record.modeId);
        if (!modeId) {
          return;
        }
        const nextConfigOptions = this.configOptions.map((option) =>
          option.id === LEGACY_MODE_CONFIG_ID ? { ...option, currentValue: modeId } : option
        );
        await this.persistConfigOptions(nextConfigOptions);
        return;
      }
      default:
        return;
    }
  }

  private async handleRequest(
    requestId: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (method === "session/request_permission") {
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const requestKey = String(requestId);
      this.pendingPermissionRequestIds.set(requestKey, requestId);
      const toolCall =
        record.toolCall && typeof record.toolCall === "object"
          ? (record.toolCall as Record<string, unknown>)
          : record.tool_call && typeof record.tool_call === "object"
            ? (record.tool_call as Record<string, unknown>)
          : {};
      const toolCallId = normalizeToolCallId(toolCall);
      const summarizedToolTitle = summarizeAcpToolCallTitle(toolCall);
      const hasConcreteToolCallId = toolCallId !== "tool-call";
      let title = "Permission required";
      if (
        typeof toolCall.title === "string" &&
        !isGenericAcpToolTitle(toolCall.title)
      ) {
        title = toolCall.title;
      } else if (summarizedToolTitle) {
        title = `Permission required for ${summarizedToolTitle}`;
      } else if (hasConcreteToolCallId) {
        title = `Permission required for ${toolCallId}`;
      }
      const detail = extractPermissionRequestDetail(record, toolCall);
      const options = parsePermissionOptions(
        Array.isArray(record.options)
          ? record.options
          : Array.isArray(record.choices)
            ? record.choices
            : Array.isArray(record.actions)
              ? record.actions
              : Array.isArray(record.permissions)
                ? record.permissions
                : []
      );
      const normalizedOptions = withPersistentPermissionOptions(
        options.length > 0 ? options : buildFallbackPermissionOptions()
      );
      const permissionSignature = buildPermissionToolSignature({
        record,
        toolCall,
        title,
        detail,
      });
      const settings = await getGlobalSettings().catch(() => undefined);
      const remembered = settings?.agents.rememberedPermissions.find(
        (rule) =>
          rule.workspaceId === this.callbacks.workspace.id &&
          rule.backendId === this.backend.id &&
          rule.toolKey === permissionSignature.toolKey
      );
      if (remembered) {
        const providerOptionId = providerOptionIdForRememberedPermission(
          normalizedOptions,
          remembered.decision
        );
        this.bridge.respond(requestId, {
          outcome: providerOptionId
            ? {
                outcome: "selected",
                optionId: providerOptionId,
              }
            : { outcome: "cancelled" },
        });
        this.pendingPermissionRequestIds.delete(requestKey);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "permission_resolved",
            requestId: requestKey,
            outcome: providerOptionId ? "selected" : "cancelled",
            optionId: remembered.optionId,
            raw: {
              rememberedPermission: {
                id: remembered.id,
                decision: remembered.decision,
                toolLabel: remembered.toolLabel,
              },
            },
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Used remembered permission for ${remembered.toolLabel}.`,
          },
        ]);
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "running",
          pendingPermission: null,
        }));
        return;
      }
      if (settings?.agents.autoAcceptAllAgentPermissions) {
        const providerOptionId = providerOptionIdForRememberedPermission(
          normalizedOptions,
          "allow"
        );
        if (providerOptionId) {
          this.bridge.respond(requestId, {
            outcome: { outcome: "selected", optionId: providerOptionId },
          });
          this.pendingPermissionRequestIds.delete(requestKey);
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "permission_resolved",
              requestId: requestKey,
              outcome: "selected",
              optionId: providerOptionId,
              raw: { autoAcceptedAll: true },
            },
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "status",
              status: "running",
              detail: "Auto-accepted (Agents → auto-approve all).",
            },
          ]);
          await this.callbacks.updateConversation((current) => ({
            ...current,
            status: "running",
            pendingPermission: null,
          }));
          return;
        }
      }
      this.pendingPermissionContextById.set(requestKey, {
        options: normalizedOptions,
        toolKey: permissionSignature.toolKey,
        toolLabel: permissionSignature.toolLabel,
      });
      const statusDetail = detail ? `${title} — ${detail}` : title;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_request",
          requestId: requestKey,
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
          raw: params,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "awaiting_permission",
          detail: statusDetail,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId: requestKey,
          requestedAt: Date.now(),
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
        },
      }));
      return;
    }

    const paramsRecord =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    if (method === "cursor/update_todos") {
      const todos =
        tryParseJsonArrayString(paramsRecord.todos) ??
        tryParseJsonArrayString(paramsRecord.items) ??
        [];
      const entries = agentPlanEntriesFromTodoLikeList(
        todos,
        this.callbacks.conversation.id,
        "todo"
      );
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "plan",
          planId: `${this.callbacks.conversation.id}-todos`,
          entries,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/task" || method === "cursor/generate_image") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "info",
          text: `${method} extension event received.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/create_plan" || method === "cursor/ask_question") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `${method} is not fully interactive yet; applying fallback response.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    this.bridge.respond(requestId, {});
  }
}
