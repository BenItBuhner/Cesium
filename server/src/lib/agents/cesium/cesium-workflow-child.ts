import { normalizeCesiumToolResultForModel } from "./cesium-history.js";
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

export const CESIUM_WORKFLOW_CHILD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "subagent",
  "read_subagent_transcript",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "switch_mode",
  "todo",
  "create_plan",
  "update_plan",
  "read_plan",
  "finalize_plan",
  "ask_question",
  "search_history",
  "read_history_page",
]);

export function isCesiumWorkflowChildToolBlocked(name: string): boolean {
  return (
    CESIUM_WORKFLOW_CHILD_BLOCKED_TOOLS.has(name) ||
    name.startsWith("workflow_") ||
    name.startsWith("orchestration_") ||
    name.startsWith("goal_") ||
    name.startsWith("burn_goal_")
  );
}

export function resolveCesiumWorkflowChildTools(
  tools: CesiumToolDefinition[]
): CesiumToolDefinition[] {
  return tools.filter((tool) => !isCesiumWorkflowChildToolBlocked(tool.name));
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
  maxIterations?: number;
  complete: (request: {
    messages: CesiumHistoryMessage[];
    tools: CesiumToolDefinition[];
    maxOutputTokens?: number;
  }) => Promise<CesiumAdapterResult>;
  executeTool: (request: CesiumToolRequest) => Promise<string>;
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

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
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
        ...(remainingTokens !== undefined ? { maxOutputTokens: remainingTokens } : {}),
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
    if (
      tokenBudget !== undefined &&
      result.usage?.totalTokens === undefined &&
      result.usage?.inputTokens === undefined &&
      result.usage?.outputTokens === undefined
    ) {
      throw new WorkflowAgentSpawnError(
        "Workflow child provider did not report token usage, so its configured token budget cannot be enforced.",
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
      const toolResult = isCesiumWorkflowChildToolBlocked(request.name)
        ? `Tool ${request.name} is blocked in workflow child agents to prevent recursive workflow control or child-agent management.`
        : await input.executeTool(request);
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
