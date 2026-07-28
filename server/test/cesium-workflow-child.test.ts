import assert from "node:assert/strict";
import test from "node:test";
import {
  runCesiumWorkflowChild,
  resolveCesiumWorkflowChildTools,
} from "../src/lib/agents/cesium/cesium-workflow-child.js";
import type { CesiumToolDefinition } from "../src/lib/agents/cesium/cesium-tools.js";
import { WorkflowAgentSpawnError } from "../src/lib/agents/workflow-types.js";

const TOOL = (name: string): CesiumToolDefinition => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

test("workflow child loops through tools, threads budget, and accumulates usage", async () => {
  const completions = [
    {
      text: "",
      toolRequests: [
        { id: "read-1", name: "read_file", arguments: { path: "AGENTS.md" } },
      ],
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
    },
    {
      text: "inspection complete",
      toolRequests: [],
      usage: { inputTokens: 11, outputTokens: 6, totalTokens: 17 },
    },
  ];
  const outputLimits: Array<number | undefined> = [];
  const advertisedTools: string[][] = [];
  let secondMessages: unknown;
  const executed: string[] = [];

  const result = await runCesiumWorkflowChild({
    prompt: "Inspect the workspace",
    system: "Workflow child",
    tools: [TOOL("read_file"), TOOL("workflow_run"), TOOL("spawn_agent")],
    tokenBudget: 40,
    complete: async ({ messages, tools, maxOutputTokens }) => {
      outputLimits.push(maxOutputTokens);
      advertisedTools.push(tools.map((tool) => tool.name));
      if (outputLimits.length === 2) {
        secondMessages = messages;
      }
      return completions.shift()!;
    },
    executeTool: async (request) => {
      executed.push(request.name);
      return "1|# AGENTS.md";
    },
  });

  assert.deepEqual(result, { value: "inspection complete", tokensUsed: 30 });
  assert.deepEqual(outputLimits, [40, 27]);
  assert.deepEqual(advertisedTools, [["read_file"], ["read_file"]]);
  assert.deepEqual(executed, ["read_file"]);
  assert.match(JSON.stringify(secondMessages), /# AGENTS\.md/);
});

test("workflow child blocks recursive tools even if a provider emits one", async () => {
  let completion = 0;
  let followupMessages: unknown;
  let executed = false;
  const result = await runCesiumWorkflowChild({
    prompt: "Do not recurse",
    system: "Workflow child",
    tools: [TOOL("read_file"), TOOL("workflow_run")],
    complete: async ({ messages }) => {
      completion += 1;
      if (completion === 1) {
        return {
          text: "",
          toolRequests: [{ id: "nested", name: "workflow_run", arguments: {} }],
          usage: { totalTokens: 3 },
        };
      }
      followupMessages = messages;
      return {
        text: "stopped",
        toolRequests: [],
        usage: { totalTokens: 2 },
      };
    },
    executeTool: async () => {
      executed = true;
      return "unexpected";
    },
  });

  assert.deepEqual(result, { value: "stopped", tokensUsed: 5 });
  assert.equal(executed, false);
  assert.match(JSON.stringify(followupMessages), /blocked in workflow child agents/);
  assert.deepEqual(
    resolveCesiumWorkflowChildTools([
      TOOL("workflow_run"),
      TOOL("workflow_status"),
      TOOL("workflow_await"),
      TOOL("subagent"),
      TOOL("read_subagent_transcript"),
      TOOL("spawn_agent"),
      TOOL("send_message"),
      TOOL("followup_task"),
      TOOL("wait_agent"),
      TOOL("interrupt_agent"),
      TOOL("list_agents"),
      TOOL("orchestration_assign_agent"),
      TOOL("orchestration_board_snapshot"),
      TOOL("goal_set"),
      TOOL("burn_goal_complete"),
      TOOL("switch_mode"),
      TOOL("ask_question"),
      TOOL("todo"),
      TOOL("read_file"),
    ]).map((tool) => tool.name),
    ["read_file"]
  );
});

test("workflow child estimates usage when the provider omits it", async () => {
  const result = await runCesiumWorkflowChild({
    prompt: "Use a budget",
    system: "Workflow child",
    tools: [],
    tokenBudget: 100,
    complete: async () => ({
      text: "unmetered",
      toolRequests: [],
    }),
    executeTool: async () => "unused",
  });
  assert.equal(result.value, "unmetered");
  assert.ok((result.tokensUsed ?? 0) > 0);
  assert.ok((result.tokensUsed ?? 0) <= 100);
});

test("workflow child tool loop is bounded and reports consumed tokens", async () => {
  await assert.rejects(
    () =>
      runCesiumWorkflowChild({
        prompt: "Loop forever",
        system: "Workflow child",
        tools: [TOOL("read_file")],
        maxIterations: 2,
        complete: async () => ({
          text: "",
          toolRequests: [{ id: "again", name: "read_file", arguments: { path: "x" } }],
          usage: { totalTokens: 4 },
        }),
        executeTool: async () => "x",
      }),
    (error) => {
      assert.ok(error instanceof WorkflowAgentSpawnError);
      assert.equal(error.tokensUsed, 8);
      assert.match(error.message, /stopped after 2 tool-response iterations/);
      return true;
    }
  );
});
