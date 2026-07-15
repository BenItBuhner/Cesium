import { randomUUID } from "node:crypto";
import type {
  AgentBackendId,
  AgentEventInput,
  AgentPlanEntry,
} from "./types.js";
import {
  buildPlanPathFromTitle,
  parsePlanEntriesFromMarkdown,
  planTitleFromMarkdown,
  writeCesiumPlanFile,
} from "./cesium-plan-files.js";

const BACKEND_PLAN_SEGMENTS: Record<AgentBackendId, string> = {
  "cesium-agent": "cesium",
  "cursor-sdk": "cursor-sdk",
  "opencode-server": "opencode",
  "gemini-acp": "gemini",
  "devin-acp": "devin",
  "codex-app-server": "codex",
  "claude-code-sdk": "claude",
  "pi-agent": "pi-agent",
  "google-antigravity-cli": "antigravity",
};

function backendPlanPath(backendId: AgentBackendId, title: string): string {
  const base = buildPlanPathFromTitle(title);
  const fileName = base.split("/").pop() || "plan.plan.md";
  return `.cesium/plans/${BACKEND_PLAN_SEGMENTS[backendId]}/${fileName}`;
}

function validatedCesiumPlanPath(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\\/g, "/").trim();
  if (!normalized) {
    return undefined;
  }
  if (!normalized.startsWith(".cesium/plans/") || !normalized.endsWith(".plan.md")) {
    return undefined;
  }
  return normalized;
}

function checkboxForStatus(status: AgentPlanEntry["status"]): string {
  switch (status) {
    case "completed":
      return "x";
    case "blocked":
      return "!";
    case "in_progress":
      return "~";
    case "pending":
    default:
      return " ";
  }
}

export function planMarkdownFromEntries(input: {
  title: string;
  overview?: string;
  entries: AgentPlanEntry[];
}): string {
  const lines = [`# ${input.title.trim() || "Plan"}`, ""];
  if (input.overview?.trim()) {
    lines.push(input.overview.trim(), "");
  }
  for (const entry of input.entries) {
    lines.push(`- [${checkboxForStatus(entry.status)}] ${entry.content}`);
  }
  if (input.entries.length === 0) {
    lines.push("- [ ] Define implementation steps");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeProviderPlanArtifact(input: {
  workspaceRoot: string;
  backendId: AgentBackendId;
  title: string;
  markdown?: string;
  overview?: string;
  entries?: AgentPlanEntry[];
  path?: string | null;
}) {
  const title = input.title.trim() || "Plan";
  const content =
    input.markdown?.trim()
      ? `${input.markdown.trim()}\n`
      : planMarkdownFromEntries({
          title,
          overview: input.overview,
          entries: input.entries ?? [],
        });
  const result = await writeCesiumPlanFile({
    workspaceRoot: input.workspaceRoot,
    title: planTitleFromMarkdown(
      validatedCesiumPlanPath(input.path) ?? backendPlanPath(input.backendId, title),
      content
    ),
    content,
    path: validatedCesiumPlanPath(input.path) ?? backendPlanPath(input.backendId, title),
  });
  const entries = result.entries.length > 0
    ? result.entries
    : parsePlanEntriesFromMarkdown(content);
  return {
    ...result,
    entries,
  };
}

export function providerPlanEvents(input: {
  conversationId: string;
  planId: string;
  artifact: { path: string; title?: string; entries: AgentPlanEntry[] };
  raw?: unknown;
}): AgentEventInput[] {
  const events: AgentEventInput[] = [
    {
      eventId: randomUUID(),
      conversationId: input.conversationId,
      kind: "plan_file",
      path: input.artifact.path,
      title: input.artifact.title,
      previewMode: "preview",
      raw: input.raw,
    },
  ];
  if (input.artifact.entries.length > 0) {
    events.push({
      eventId: randomUUID(),
      conversationId: input.conversationId,
      kind: "plan",
      planId: input.planId,
      entries: input.artifact.entries,
      raw: input.raw,
    });
  }
  return events;
}
