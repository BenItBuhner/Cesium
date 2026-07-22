import { normalizeCesiumToolResultForModel } from "./cesium-history.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./cesium-prompt.js";
import type { CesiumToolDefinition } from "./cesium-tools.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
  CesiumToolRequest,
} from "./cesium-types.js";
import {
  WorkflowAgentSpawnError,
  type WorkflowAgentSpawnResult,
} from "../workflow-types.js";

export const CESIUM_WORKFLOW_CHILD_MAX_ITERATIONS = 20;

export const CESIUM_WORKFLOW_CHILD_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "edit_file",
  "terminal",
  "wait",
  "call_mcp_tool",
]);

export function isCesiumWorkflowChildToolBlocked(name: string): boolean {
  return !CESIUM_WORKFLOW_CHILD_ALLOWED_TOOLS.has(name);
}

export function resolveCesiumWorkflowChildTools(
  tools: CesiumToolDefinition[]
): CesiumToolDefinition[] {
  return tools
    .filter((tool) => !isCesiumWorkflowChildToolBlocked(tool.name))
    .map((tool) =>
      tool.name === "terminal"
        ? {
            ...tool,
            description:
              `${tool.description} Workflow children must use waitUntil=complete; background and pattern commands are rejected so no process outlives the workflow.`,
          }
        : tool
    );
}

function resultTokenCount(result: CesiumAdapterResult): number {
  const total = result.usage?.totalTokens;
  if (typeof total === "number" && Number.isFinite(total)) {
    return Math.max(0, Math.floor(total));
  }
  return Math.max(
    0,
    Math.floor((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0))
  );
}

function parseSchemaResult(text: string): unknown {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(jsonText) as unknown;
}

export async function runCesiumWorkflowChild(input: {
  prompt: string;
  system: string;
  schema?: Record<string, unknown>;
  tools: CesiumToolDefinition[];
  tokenBudget?: number;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  maxIterations?: number;
  complete: (request: {
    messages: CesiumHistoryMessage[];
    tools: CesiumToolDefinition[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }) => Promise<CesiumAdapterResult>;
  executeTool: (
    request: CesiumToolRequest,
    context: { signal?: AbortSignal }
  ) => Promise<string>;
}): Promise<WorkflowAgentSpawnResult> {
  const tools = resolveCesiumWorkflowChildTools(input.tools);
  const messages: CesiumHistoryMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.prompt },
  ];
  const tokenBudget =
    typeof input.tokenBudget === "number" && Number.isFinite(input.tokenBudget)
      ? Math.max(0, Math.floor(input.tokenBudget))
      : undefined;
  const maxIterations = Math.max(
    1,
    Math.floor(input.maxIterations ?? CESIUM_WORKFLOW_CHILD_MAX_ITERATIONS)
  );
  let tokensUsed = 0;
  let usedToolResultChars = 0;
  let schemaFailures = 0;

  const throwIfAborted = () => {
    if (input.signal?.aborted) {
      const error = new Error("Workflow child cancelled.");
      error.name = "AbortError";
      throw error;
    }
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    throwIfAborted();
    await input.checkpoint?.();
    throwIfAborted();
    const remainingTokens =
      tokenBudget === undefined ? undefined : Math.max(0, tokenBudget - tokensUsed);
    if (remainingTokens === 0) {
      throw new WorkflowAgentSpawnError(
        `Workflow child token budget exhausted after ${tokensUsed} tokens.`,
        tokensUsed
      );
    }

    let result: CesiumAdapterResult;
    try {
      result = await input.complete({
        messages,
        tools,
        ...(remainingTokens !== undefined
          ? { maxOutputTokens: Math.min(remainingTokens, DEFAULT_MAX_OUTPUT_TOKENS) }
          : {}),
        signal: input.signal,
      });
    } catch (error) {
      if (tokensUsed === 0 || error instanceof WorkflowAgentSpawnError) {
        throw error;
      }
      throw new WorkflowAgentSpawnError(
        error instanceof Error ? error.message : String(error),
        tokensUsed
      );
    }
    tokensUsed += resultTokenCount(result);
    throwIfAborted();
    await input.checkpoint?.();
    throwIfAborted();
    if (
      tokenBudget !== undefined &&
      result.usage?.totalTokens === undefined &&
      result.usage?.inputTokens === undefined &&
      result.usage?.outputTokens === undefined
    ) {
      throw new WorkflowAgentSpawnError(
        "Workflow child provider did not report token usage, so Cesium cannot account for its best-effort token budget.",
        tokensUsed
      );
    }
    const text = result.text.trim();

    if (result.toolRequests.length === 0) {
      if (!input.schema) {
        return { value: text, tokensUsed };
      }
      try {
        return { value: parseSchemaResult(text), tokensUsed };
      } catch (error) {
        schemaFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (schemaFailures >= 2) {
          throw new WorkflowAgentSpawnError(message, tokensUsed);
        }
        messages.push(
          { role: "assistant", content: result.text },
          {
            role: "user",
            content: `Previous response failed validation: ${message}\nReturn corrected output only.`,
          }
        );
        continue;
      }
    }

    messages.push({
      role: "assistant",
      content: text,
      toolCalls: result.toolRequests.map((request) => ({
        id: request.id,
        name: request.name,
        arguments: JSON.stringify(request.arguments),
      })),
    });
    for (const request of result.toolRequests) {
      throwIfAborted();
      await input.checkpoint?.();
      throwIfAborted();
      const toolResult = isCesiumWorkflowChildToolBlocked(request.name)
        ? `Tool ${request.name} is blocked in workflow child agents to prevent recursive workflow control or child-agent management.`
        : await input.executeTool(request, { signal: input.signal });
      throwIfAborted();
      await input.checkpoint?.();
      throwIfAborted();
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
    }
  }

  throw new WorkflowAgentSpawnError(
    `Workflow child stopped after ${maxIterations} tool-response iterations to avoid an infinite tool loop.`,
    tokensUsed
  );
}
