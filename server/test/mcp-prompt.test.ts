import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCesiumBaseSystemPrompt,
  buildCesiumSystemPrompt,
  buildMcpPopulatedSection,
} from "@cesium/core/mcp";
import { buildCesiumTurnReminder } from "../src/lib/agents/cesium-reminders.js";

test("buildCesiumSystemPrompt appends empty MCP section when no servers", () => {
  const prompt = buildCesiumSystemPrompt();
  assert.match(prompt, /## Persona/);
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

test("buildCesiumTurnReminder carries MCP change notices outside the base prompt", () => {
  const reminder = buildCesiumTurnReminder({
    workspaceRoot: "/tmp/workspace",
    dateLabel: "Sunday, May 31, 2026",
    gitSummary: "main clean",
    mcpSummaries: [{ id: "browser", label: "Browser", summary: "Built-in browser tools" }],
    mcpChangeNotice: "- MCP server enabled: Browser.",
  });
  assert.match(reminder, /MCP Changes Since Last Turn/);
  assert.match(reminder, /MCP server enabled: Browser/);

  const basePrompt = buildCesiumSystemPrompt();
  assert.doesNotMatch(basePrompt, /MCP Changes Since Last Turn/);
});

test("base prompt is byte-identical to the checked-in snapshot", async () => {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cesium-code-base-prompt.snapshot.txt"
  );
  assert.equal(buildCesiumBaseSystemPrompt(), await readFile(fixturePath, "utf8"));
});

test("base prompt has no unfilled template placeholders", () => {
  assert.deepEqual(buildCesiumBaseSystemPrompt().match(/\{[a-z_]+\}/g) ?? [], []);
});

test("model name and workspace root are the only substitutions and are session-stable", () => {
  const first = buildCesiumBaseSystemPrompt({
    modelName: "Kimi K3",
    workspaceRoot: "/srv/repos/cesium",
  });
  assert.ok(first.includes("powered by the Kimi K3 model"));
  assert.ok(first.includes("You are under the `/srv/repos/cesium` directory"));
  assert.equal(
    first,
    buildCesiumBaseSystemPrompt({ modelName: "Kimi K3", workspaceRoot: "/srv/repos/cesium" })
  );
  assert.ok(!first.includes(new Date().getFullYear().toString()));
  const fallback = buildCesiumBaseSystemPrompt({ modelName: "  ", workspaceRoot: "" });
  assert.ok(fallback.includes("powered by the configured model"));
  assert.ok(fallback.includes("You are under the `current workspace` directory"));
});
