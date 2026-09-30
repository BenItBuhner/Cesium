import { randomUUID } from "node:crypto";
import { readCesiumPlanFile, writeCesiumPlanFile } from "../../cesium-plan-files.js";
import type { AgentEventInput, AgentPlanEntry } from "../../types.js";
import { asString } from "../cesium-coerce.js";
import {
  CESIUM_TODO_PLAN_ID,
  applyTodoPatch,
  latestTodoEntries,
  parseTodoItems,
  todoEntriesFromReplace,
} from "../cesium-todo.js";
import type { CesiumToolContext } from "./types.js";

export async function appendPlanFileEvents(
  ctx: CesiumToolContext,
  plan: Awaited<ReturnType<typeof readCesiumPlanFile>>, raw: unknown): Promise<void> {
  const events: AgentEventInput[] = [
    {
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "plan_file",
      path: plan.path,
      title: plan.title,
      previewMode: "preview",
      raw,
    },
  ];
  if (plan.entries.length > 0) {
    events.push({
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "plan",
      planId: `plan-file:${plan.path}`,
      entries: plan.entries,
      raw,
    });
  }
  await ctx.appendEvents(events);
}

export async function createPlanTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const title = asString(args.title);
  const content = asString(args.content);
  if (!title) throw new Error("create_plan.title is required.");
  if (!content) throw new Error("create_plan.content is required.");
  const plan = await writeCesiumPlanFile({
    workspaceRoot: ctx.workspace.root,
    title,
    content,
    path: asString(args.path),
  });
  await appendPlanFileEvents(ctx, plan, args);
  return `Created plan ${plan.path} with ${plan.entries.length} checklist item${plan.entries.length === 1 ? "" : "s"}.`;
}

export async function updatePlanTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const planPath = asString(args.path);
  const content = asString(args.content);
  if (!planPath) throw new Error("update_plan.path is required.");
  if (!content) throw new Error("update_plan.content is required.");
  const plan = await writeCesiumPlanFile({
    workspaceRoot: ctx.workspace.root,
    title: asString(args.title) ?? "Plan",
    content,
    path: planPath,
  });
  await appendPlanFileEvents(ctx, plan, args);
  return `Updated plan ${plan.path} with ${plan.entries.length} checklist item${plan.entries.length === 1 ? "" : "s"}.`;
}

export async function readPlanTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const planPath = asString(args.path);
  if (!planPath) throw new Error("read_plan.path is required.");
  const plan = await readCesiumPlanFile({
    workspaceRoot: ctx.workspace.root,
    path: planPath,
  });
  return [
    `Plan: ${plan.title}`,
    `Path: ${plan.path}`,
    `Checklist items: ${plan.entries.length}`,
    "",
    plan.content,
  ].join("\n");
}

export async function finalizePlanTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const planPath = asString(args.path);
  if (!planPath) throw new Error("finalize_plan.path is required.");
  const plan = await readCesiumPlanFile({
    workspaceRoot: ctx.workspace.root,
    path: planPath,
  });
  await appendPlanFileEvents(ctx, plan, args);
  return `Finalized plan ${plan.path} for review.`;
}

export async function todoTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const action = asString(args.action) ?? "list";
  const items = Array.isArray(args.items) ? args.items : [];
  if (action === "list") {
    const snapshot = await ctx.readSnapshot();
    const latest = latestTodoEntries(snapshot?.events ?? []);
    return latest
      ? latest.map((entry) => `${entry.status}: ${entry.content}`).join("\n")
      : "No todos yet.";
  }
  const parsedItems = parseTodoItems(items);
  let entries: AgentPlanEntry[];
  if (action === "patch") {
    const snapshot = await ctx.readSnapshot();
    entries = applyTodoPatch(latestTodoEntries(snapshot?.events ?? []) ?? [], parsedItems);
  } else {
    const snapshot = await ctx.readSnapshot();
    entries = todoEntriesFromReplace(parsedItems, latestTodoEntries(snapshot?.events ?? []) ?? []);
  }
  await ctx.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "plan",
      planId: CESIUM_TODO_PLAN_ID,
      entries,
      raw: args,
    },
  ]);
  return action === "patch"
    ? `Patched ${parsedItems.length} todo item${parsedItems.length === 1 ? "" : "s"}; the list now has ${entries.length}.`
    : `Stored ${entries.length} todo item${entries.length === 1 ? "" : "s"}.`;
}
