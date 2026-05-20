import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCesiumSystemPrompt,
  buildMcpPopulatedSection,
  CESIUM_MCP_EMPTY_SECTION,
} from "@cesium/core/mcp";

test("buildCesiumSystemPrompt appends empty MCP section when no servers", () => {
  const prompt = buildCesiumSystemPrompt();
  assert.match(prompt, /MCP Server Usage/);
  assert.match(prompt, /has not connected any tools/);
});

test("buildMcpPopulatedSection lists servers and mcp-servers path", () => {
  const section = buildMcpPopulatedSection([
    { id: "context7", label: "Context7", summary: "Library docs" },
  ]);
  assert.match(section, /Context7/);
  assert.match(section, /call_mcp_tool/);
  assert.match(section, /mcp-servers/);
});

test("buildCesiumSystemPrompt uses populated section when summaries exist", () => {
  const prompt = buildCesiumSystemPrompt({
    mcpSummaries: [{ id: "context7", label: "Context7", summary: "Docs" }],
  });
  assert.doesNotMatch(prompt, /has not connected any tools/);
  assert.match(prompt, /you are exposed to 1 server/);
});
