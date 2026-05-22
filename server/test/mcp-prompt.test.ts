import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCesiumOrchestrationSystemPrompt,
  buildCesiumSystemPrompt,
  buildMcpPopulatedSection,
  CESIUM_MCP_EMPTY_SECTION,
} from "@cesium/core/mcp";

test("buildCesiumSystemPrompt appends empty MCP section when no servers", () => {
  const prompt = buildCesiumSystemPrompt();
  assert.match(prompt, /## Persona/);
  assert.match(prompt, /agent mode/);
  assert.match(prompt, /Third-Party & MCP Server Tools/);
  assert.match(prompt, /has not connected any MCP servers/);
});

test("buildMcpPopulatedSection lists servers and mcp-servers path", () => {
  const section = buildMcpPopulatedSection([
    { id: "context7", label: "Context7", summary: "Library docs" },
  ]);
  assert.match(section, /Context7/);
  assert.match(section, /Third-Party & MCP Server Tools/);
  assert.match(section, /call_mcp_tool/);
  assert.match(section, /mcp-servers/);
});

test("buildCesiumSystemPrompt uses populated section when summaries exist", () => {
  const prompt = buildCesiumSystemPrompt({
    mcpSummaries: [{ id: "context7", label: "Context7", summary: "Docs" }],
    modelName: "gpt-5.1",
    workspaceRoot: "/tmp/workspace",
  });
  assert.match(prompt, /gpt-5\.1/);
  assert.match(prompt, /\/tmp\/workspace/);
  assert.doesNotMatch(prompt, /has not connected any MCP servers/);
  assert.match(prompt, /Context7/);
  assert.match(prompt, /mcp-servers/);
});

test("buildCesiumOrchestrationSystemPrompt describes board-first management", () => {
  const prompt = buildCesiumOrchestrationSystemPrompt({
    modelName: "gpt-5.1",
    workspaceRoot: "/tmp/workspace",
    boardId: "board-1",
    maxConcurrentAgents: 3,
  });
  assert.match(prompt, /## Persona/);
  assert.match(prompt, /orchestration mode/);
  assert.match(prompt, /gpt-5\.1/);
  assert.match(prompt, /Orchestration Harness/);
  assert.match(prompt, /kanban board/);
  assert.match(prompt, /kanban board replaces todos/);
  assert.match(prompt, /hidden from the main rail/);
  assert.match(prompt, /permissions default to allow/);
  assert.match(prompt, /orchestration_control_agent/);
  assert.match(prompt, /orchestration_delete_issue/);
  assert.match(prompt, /pause, resume, stop, or steer/);
  assert.match(prompt, /does not force itself to continue/);
  assert.match(prompt, /assignment_finished/);
  assert.match(prompt, /orchestration_create_issue/);
  assert.match(prompt, /board-1/);
  assert.match(prompt, /Maximum concurrent agents: 3/);
});
