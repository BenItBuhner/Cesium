import {
  BROWSER_MCP_TOOLS,
  callBuiltInBrowserTool,
} from "../../mcp/builtin-browser-tools.js";
import { isBuiltInBrowserMcpEnabled } from "../../mcp/server-store.js";
import { runAdapter } from "./cesium-model-adapters.js";
import { normalizeCesiumToolResultForModel } from "./cesium-history.js";
import type { CesiumToolDefinition } from "./features/types.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
} from "./cesium-types.js";
import type { CesiumProviderKind } from "../../cesium-agent-settings.js";

/**
 * Tool surface handed to ephemeral/collaborative Cesium subagents. Subagents
 * are intentionally sandboxed to browser control (site testing, screenshots,
 * demo recordings) so a primary agent can delegate product-verification work
 * without exposing file-edit or terminal tools to unattended children.
 */
export type CesiumSubagentToolset = {
  tools: CesiumToolDefinition[];
  toolNames: Set<string>;
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
};

const SUBAGENT_BROWSER_GUIDANCE =
  "You can drive the built-in Cesium browser with the browser_* tools: open tabs with browser_tabs (engine server-chromium), " +
  "navigate, snapshot, click, type, set viewports, capture screenshots with browser_screenshot, and record demo videos with " +
  "browser_record (action=start before the demo interactions, action=stop after). Screenshots and videos are saved under " +
  "artifacts/browser/ in the workspace — always list those exact file paths in your final summary so the parent agent and the " +
  "user can open them. Close tabs you opened when finished.";

export function subagentToolsetGuidance(toolset: CesiumSubagentToolset | null | undefined): string {
  return toolset && toolset.tools.length > 0 ? SUBAGENT_BROWSER_GUIDANCE : "";
}

export function createBrowserSubagentToolset(workspace: {
  id: string;
  root: string;
}): CesiumSubagentToolset {
  const tools: CesiumToolDefinition[] = BROWSER_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));
  return {
    tools,
    toolNames: new Set(tools.map((tool) => tool.name)),
    execute: async (name, args) => {
      if (!(await isBuiltInBrowserMcpEnabled(workspace.id))) {
        throw new Error("Browser MCP is disabled for this workspace.");
      }
      return await callBuiltInBrowserTool({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        toolName: name,
        arguments: args,
      });
    },
  };
}

export type SubagentToolLoopToolEvent = {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  ok: boolean;
};

export type SubagentToolLoopResult = {
  text: string;
  toolCallCount: number;
};

const SUBAGENT_MAX_TOOL_ITERATIONS = 24;

/**
 * Minimal assistant/tool round-trip loop for subagent turns. Mirrors the main
 * Cesium turn loop shape (assistant tool_calls followed by tool results) but
 * with a restricted toolset and bounded iterations.
 */
export async function runSubagentToolLoop(input: {
  adapter: {
    apiKind: CesiumProviderKind;
    apiKey: string;
    baseUrl?: string;
    providerId: string;
    modelId: string;
  };
  messages: CesiumHistoryMessage[];
  toolset?: CesiumSubagentToolset | null;
  maxIterations?: number;
  isAborted?: () => boolean;
  onToolCall?: (event: SubagentToolLoopToolEvent) => void | Promise<void>;
  /** Test seam: overrides the model adapter call. */
  runAdapterImpl?: typeof runAdapter;
}): Promise<SubagentToolLoopResult> {
  const toolset = input.toolset ?? null;
  const tools = toolset?.tools ?? [];
  const adapterImpl = input.runAdapterImpl ?? runAdapter;
  const maxIterations = Math.max(1, input.maxIterations ?? SUBAGENT_MAX_TOOL_ITERATIONS);
  const messages: CesiumHistoryMessage[] = [...input.messages];
  let usedToolResultChars = 0;
  let toolCallCount = 0;
  let lastResult: CesiumAdapterResult | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (input.isAborted?.()) {
      return { text: lastResult?.text ?? "", toolCallCount };
    }
    const result = await adapterImpl({
      apiKind: input.adapter.apiKind,
      apiKey: input.adapter.apiKey,
      baseUrl: input.adapter.baseUrl,
      providerId: input.adapter.providerId,
      modelId: input.adapter.modelId,
      messages,
      // Explicit empty array when no toolset: adapters omit tools from the
      // provider payload instead of exposing the full default tool surface.
      tools,
    });
    lastResult = result;
    if (result.toolRequests.length === 0 || !toolset) {
      return { text: result.text, toolCallCount };
    }
    messages.push({
      role: "assistant",
      content: result.text.trim(),
      toolCalls: result.toolRequests.map((request) => ({
        id: request.id,
        name: request.name,
        arguments: JSON.stringify(request.arguments),
      })),
    });
    for (const request of result.toolRequests) {
      if (input.isAborted?.()) {
        return { text: result.text, toolCallCount };
      }
      let toolResult = "";
      let ok = true;
      if (!toolset.toolNames.has(request.name)) {
        ok = false;
        toolResult = `Tool ${request.name} is not available to this subagent. Available tools: ${[...toolset.toolNames].join(", ")}.`;
      } else {
        try {
          toolResult = await toolset.execute(request.name, request.arguments);
        } catch (error) {
          ok = false;
          toolResult = `Tool ${request.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
      toolCallCount += 1;
      const normalized = normalizeCesiumToolResultForModel({
        toolName: request.name,
        result: toolResult,
        usedToolResultChars,
      });
      usedToolResultChars = normalized.usedToolResultChars;
      messages.push({
        role: "tool",
        toolCallId: request.id,
        name: request.name,
        content: normalized.content,
      });
      await input.onToolCall?.({
        toolCallId: request.id,
        name: request.name,
        arguments: request.arguments,
        result: toolResult,
        ok,
      });
    }
  }
  return {
    text:
      lastResult?.text?.trim() ||
      `Subagent stopped after ${maxIterations} tool iterations without a final answer.`,
    toolCallCount,
  };
}
