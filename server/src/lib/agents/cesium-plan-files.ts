import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentPlanEntry } from "./types.js";

export const CESIUM_PLAN_DIR = ".cesium/plans";

export type CesiumPlanFileResult = {
  path: string;
  title: string;
  content: string;
  entries: AgentPlanEntry[];
};

function slugifyPlanTitle(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `plan-${Date.now()}`;
}

function normalizePlanRelativePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(`${CESIUM_PLAN_DIR}/`)) {
    throw new Error(`Plan files must live under ${CESIUM_PLAN_DIR}/.`);
  }
  if (!normalized.endsWith(".plan.md")) {
    throw new Error("Plan files must use the .plan.md extension.");
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Plan file path contains an invalid segment.");
  }
  return normalized;
}

export function buildPlanPathFromTitle(title: string): string {
  return `${CESIUM_PLAN_DIR}/${slugifyPlanTitle(title)}.plan.md`;
}

export function planTitleFromMarkdown(pathValue: string, content: string): string {
  const heading = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((line) => line.startsWith("# "));
  if (heading?.slice(2).trim()) {
    return heading.slice(2).trim();
  }
  const basename = path.basename(pathValue, ".plan.md").replace(/[-_]+/g, " ").trim();
  return basename ? basename.replace(/\b\w/g, (match) => match.toUpperCase()) : "Plan";
}

export function parsePlanEntriesFromMarkdown(content: string): AgentPlanEntry[] {
  const entries: AgentPlanEntry[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^\s*[-*]\s+\[( |x|X|!|~|-)\]\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const marker = match[1];
    const text = match[2]?.trim();
    if (!text) {
      continue;
    }
    const status: AgentPlanEntry["status"] =
      marker === "x" || marker === "X"
        ? "completed"
        : marker === "!" || marker === "~" || marker === "-"
          ? "blocked"
          : "pending";
    entries.push({
      id: `plan-item-${index + 1}`,
      content: text,
      status,
    });
  }
  return entries;
}

export async function writeCesiumPlanFile(input: {
  workspaceRoot: string;
  title: string;
  content: string;
  path?: string | null;
}): Promise<CesiumPlanFileResult> {
  const relativePath = normalizePlanRelativePath(input.path?.trim() || buildPlanPathFromTitle(input.title));
  const absolutePath = path.join(input.workspaceRoot, relativePath);
  const planDir = path.join(input.workspaceRoot, CESIUM_PLAN_DIR);
  if (!absolutePath.startsWith(planDir)) {
    throw new Error("Plan file resolved outside the Cesium plan directory.");
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, input.content, "utf8");
  const title = input.title.trim() || planTitleFromMarkdown(relativePath, input.content);
  return {
    path: relativePath,
    title,
    content: input.content,
    entries: parsePlanEntriesFromMarkdown(input.content),
  };
}

export async function readCesiumPlanFile(input: {
  workspaceRoot: string;
  path: string;
}): Promise<CesiumPlanFileResult> {
  const relativePath = normalizePlanRelativePath(input.path);
  const absolutePath = path.join(input.workspaceRoot, relativePath);
  const content = await fs.readFile(absolutePath, "utf8");
  return {
    path: relativePath,
    title: planTitleFromMarkdown(relativePath, content),
    content,
    entries: parsePlanEntriesFromMarkdown(content),
  };
}
