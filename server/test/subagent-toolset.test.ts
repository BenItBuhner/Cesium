import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-subagent-toolset-data-")
);

const {
  createBrowserSubagentToolset,
  runSubagentToolLoop,
  subagentToolsetGuidance,
} = await import("../src/lib/agents/cesium/subagent-toolset.js");
const { listBrowserControlTabs, resetBrowserControlForTests } = await import(
  "../src/lib/browser-control/service.js"
);
const { BROWSER_MCP_TOOLS } = await import("../src/lib/mcp/builtin-browser-tools.js");
import type { CesiumAdapterResult } from "../src/lib/agents/cesium/cesium-types.js";

test("browser subagent toolset exposes the full built-in browser tool surface", () => {
  const toolset = createBrowserSubagentToolset({ id: "ws-toolset", root: os.tmpdir() });
  assert.equal(toolset.tools.length, BROWSER_MCP_TOOLS.length);
  assert.ok(toolset.toolNames.has("browser_tabs"));
  assert.ok(toolset.toolNames.has("browser_screenshot"));
  assert.ok(toolset.toolNames.has("browser_record"));
  assert.match(subagentToolsetGuidance(toolset), /artifacts\/browser\//);
  assert.equal(subagentToolsetGuidance(null), "");
});

test("subagent tool loop executes browser tools and returns the final text", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-subagent-loop";
  const toolset = createBrowserSubagentToolset({ id: workspaceId, root: os.tmpdir() });
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
  const toolset = createBrowserSubagentToolset({ id: "ws-reject", root: os.tmpdir() });
  let call = 0;
  const rejected: string[] = [];
  const result = await runSubagentToolLoop({
    adapter: {
      apiKind: "openai-chat-completions",
      apiKey: "test",
      providerId: "openai",
      modelId: "openai/test-model",
    },
    messages: [{ role: "user", content: "try to edit files" }],
    toolset,
    runAdapterImpl: async (input): Promise<CesiumAdapterResult> => {
      call += 1;
      if (call === 1) {
        return {
          text: "",
          toolRequests: [
            { id: "tool-x", name: "write_file", arguments: { path: "x", content: "y" } },
          ],
        };
      }
      const toolMessage = input.messages.find((message) => message.role === "tool");
      assert.match(toolMessage!.content, /not available to this subagent/);
      return { text: "Understood, browser tools only.", toolRequests: [] };
    },
    onToolCall: async (event) => {
      if (!event.ok) rejected.push(event.name);
    },
  });
  assert.equal(result.text, "Understood, browser tools only.");
  assert.deepEqual(rejected, ["write_file"]);
});

test("subagent tool loop stops at max iterations", async () => {
  const toolset = createBrowserSubagentToolset({ id: "ws-max", root: os.tmpdir() });
  const result = await runSubagentToolLoop({
    adapter: {
      apiKind: "openai-chat-completions",
      apiKey: "test",
      providerId: "openai",
      modelId: "openai/test-model",
    },
    messages: [{ role: "user", content: "loop forever" }],
    toolset,
    maxIterations: 2,
    runAdapterImpl: async (): Promise<CesiumAdapterResult> => ({
      text: "",
      toolRequests: [{ id: `tool-${Math.random()}`, name: "browser_tabs", arguments: { action: "list" } }],
    }),
  });
  assert.match(result.text, /stopped after 2 tool iterations/);
  assert.equal(result.toolCallCount, 2);
});
