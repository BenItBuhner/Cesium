import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-subagent-toolset-data-")
);

const {
  createSubagentToolset,
  runSubagentToolLoop,
  subagentToolDefinitions,
  subagentToolsetGuidance,
  SUBAGENT_COLLABORATION_TOOL_NAMES,
  SUBAGENT_SHARED_HOST_TOOL_NAMES,
} = await import("../src/lib/agents/cesium/subagent-toolset.js");
const { resolveCesiumTools } = await import("../src/lib/agents/cesium/cesium-tools.js");
const { listBrowserControlTabs, resetBrowserControlForTests } = await import(
  "../src/lib/browser-control/service.js"
);
const { BROWSER_MCP_TOOLS, callBuiltInBrowserTool } = await import(
  "../src/lib/mcp/builtin-browser-tools.js"
);
import type { CesiumAdapterResult } from "../src/lib/agents/cesium/cesium-types.js";
import type { CesiumSubagentToolset } from "../src/lib/agents/cesium/subagent-toolset.js";

function browserBackedToolset(workspaceId: string): CesiumSubagentToolset {
  const definitions = subagentToolDefinitions({
    hostTools: resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools,
    includeCollaboration: true,
  });
  return createSubagentToolset({
    definitions,
    execute: async (name, args) => {
      if (name.startsWith("browser_")) {
        return await callBuiltInBrowserTool({
          workspaceId,
          workspaceRoot: os.tmpdir(),
          toolName: name,
          arguments: args,
        });
      }
      return `stub:${name}`;
    },
  });
}

test("subagents share the host workspace tool surface plus browser and collaboration tools (Codex parity)", () => {
  const host = resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools;
  const defs = subagentToolDefinitions({ hostTools: host, includeCollaboration: true });
  const names = new Set(defs.map((tool) => tool.name));
  for (const shared of SUBAGENT_SHARED_HOST_TOOL_NAMES) {
    assert.ok(names.has(shared), `missing shared host tool ${shared}`);
  }
  for (const browserTool of BROWSER_MCP_TOOLS) {
    assert.ok(names.has(browserTool.name), `missing browser tool ${browserTool.name}`);
  }
  for (const collab of SUBAGENT_COLLABORATION_TOOL_NAMES) {
    assert.ok(names.has(collab), `missing collaboration tool ${collab}`);
  }
  // Parent-conversation control tools stay excluded - children have no
  // conversation of their own for these to act on.
  for (const excluded of ["switch_mode", "create_plan", "goal_set", "orchestration_create_issue", "ask_question"]) {
    assert.equal(names.has(excluded), false, `${excluded} must not leak to subagents`);
  }
  // Permission markers are preserved so the shared cascade still gates children.
  const terminal = defs.find((tool) => tool.name === "terminal");
  assert.equal(terminal?.requiresPermission, "terminal");
  const editFile = defs.find((tool) => tool.name === "edit_file");
  assert.equal(editFile?.requiresPermission, "editFile");
});

test("collaboration tools are omitted for single-shot (v1) subagents", () => {
  const host = resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools;
  const defs = subagentToolDefinitions({ hostTools: host, includeCollaboration: false });
  const names = new Set(defs.map((tool) => tool.name));
  assert.equal(names.has("spawn_agent"), false);
  assert.ok(names.has("read_file"));
  assert.ok(names.has("browser_record"));
});

test("guidance reflects the shared-workspace protocol and collaboration availability", () => {
  const host = resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools;
  const collab = createSubagentToolset({
    definitions: subagentToolDefinitions({ hostTools: host, includeCollaboration: true }),
    execute: async () => "",
  });
  const solo = createSubagentToolset({
    definitions: subagentToolDefinitions({ hostTools: host, includeCollaboration: false }),
    execute: async () => "",
  });
  assert.match(subagentToolsetGuidance(collab), /same filesystem and working directory/);
  assert.match(subagentToolsetGuidance(collab), /spawn_agent creates a child/);
  assert.match(subagentToolsetGuidance(solo), /artifacts\/browser\//);
  assert.doesNotMatch(subagentToolsetGuidance(solo), /spawn_agent creates a child/);
  assert.equal(subagentToolsetGuidance(null), "");
});

test("subagent tool loop executes browser tools and returns the final text", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-subagent-loop";
  const toolset = browserBackedToolset(workspaceId);
  const seenToolNames: string[] = [];
  let call = 0;
  const result = await runSubagentToolLoop({
    adapter: {
      apiKind: "openai-chat-completions",
      apiKey: "test",
      providerId: "openai",
      modelId: "openai/test-model",
    },
    messages: [
      { role: "system", content: "test" },
      { role: "user", content: "open a tab" },
    ],
    toolset,
    runAdapterImpl: async (input): Promise<CesiumAdapterResult> => {
      call += 1;
      if (call === 1) {
        assert.ok((input.tools?.length ?? 0) > 0, "toolset should be passed to the adapter");
        return {
          text: "",
          toolRequests: [
            {
              id: "tool-1",
              name: "browser_tabs",
              arguments: { action: "open", url: "https://example.com", engine: "proxy" },
            },
          ],
        };
      }
      const toolMessage = input.messages.find((message) => message.role === "tool");
      assert.ok(toolMessage, "tool result should be appended to the follow-up request");
      assert.match(toolMessage!.content, /opened_browser_tab/);
      return { text: "Opened the tab and verified it.", toolRequests: [] };
    },
    onToolCall: async (event) => {
      seenToolNames.push(event.name);
      assert.equal(event.ok, true);
    },
  });
  assert.equal(result.text, "Opened the tab and verified it.");
  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(seenToolNames, ["browser_tabs"]);
  assert.equal(listBrowserControlTabs(workspaceId).length, 1);
  resetBrowserControlForTests();
});

test("subagent tool loop rejects tools outside the toolset", async () => {
  const toolset = createSubagentToolset({
    definitions: subagentToolDefinitions({
      hostTools: resolveCesiumTools({ features: { subagents: { version: 2 } } }).tools,
      includeCollaboration: false,
    }),
    execute: async () => "unused",
  });
  let call = 0;
  const rejected: string[] = [];
  const result = await runSubagentToolLoop({
    adapter: {
      apiKind: "openai-chat-completions",
      apiKey: "test",
      providerId: "openai",
      modelId: "openai/test-model",
    },
    messages: [{ role: "user", content: "try a parent-only tool" }],
    toolset,
    runAdapterImpl: async (input): Promise<CesiumAdapterResult> => {
      call += 1;
      if (call === 1) {
        return {
          text: "",
          toolRequests: [
            { id: "tool-x", name: "switch_mode", arguments: { target_mode: "plan" } },
          ],
        };
      }
      const toolMessage = input.messages.find((message) => message.role === "tool");
      assert.match(toolMessage!.content, /not available to this subagent/);
      return { text: "Understood.", toolRequests: [] };
    },
    onToolCall: async (event) => {
      if (!event.ok) rejected.push(event.name);
    },
  });
  assert.equal(result.text, "Understood.");
  assert.deepEqual(rejected, ["switch_mode"]);
});

test("subagent tool loop has no iteration cap", async () => {
  const formerCap = 40;
  const toolRounds = formerCap + 1;
  const toolset = createSubagentToolset({
    definitions: [{ name: "wait", description: "", parameters: { type: "object", properties: {} } }],
    execute: async () => "ok",
  });
  let call = 0;
  const result = await runSubagentToolLoop({
    adapter: {
      apiKind: "openai-chat-completions",
      apiKey: "test",
      providerId: "openai",
      modelId: "openai/test-model",
    },
    messages: [{ role: "user", content: "keep going" }],
    toolset,
    runAdapterImpl: async (): Promise<CesiumAdapterResult> => {
      call += 1;
      if (call <= toolRounds) {
        return {
          text: "",
          toolRequests: [{ id: `tool-${call}`, name: "wait", arguments: {} }],
        };
      }
      return { text: "Finished after many tool rounds.", toolRequests: [] };
    },
  });
  assert.equal(result.text, "Finished after many tool rounds.");
  assert.equal(result.toolCallCount, toolRounds);
  assert.equal(call, toolRounds + 1);
});
