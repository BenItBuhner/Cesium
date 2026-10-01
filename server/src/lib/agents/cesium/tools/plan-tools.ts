import { randomUUID } from "node:crypto";
import { readCesiumPlanFile, writeCesiumPlanFile } from "../../cesium-plan-files.js";
import type { AgentEventInput, AgentPlanEntry } from "../../types.js";
import { asString } from "../cesium-coerce.js";
import {
  CESIUM_TODO_PLAN_ID,
  applyTodoPatch,
  parseTodoItems,
  todoEntriesFromReplace,
} from "../cesium-todo.js";
import {
  ledgerMilestones,
  ledgerPlanEntries,
  ledgerTasks,
  newLedgerItem,
  readWorkLedger,
  writeWorkLedger,
  type WorkLedgerItem,
  type WorkLedgerScope,
} from "../../work-ledger.js";
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

/** The ledger as the current conversation's agent sees and changes it. */
export function ledgerScope(ctx: CesiumToolContext): WorkLedgerScope {
  return {
    workspace: ctx.workspace,
    conversationId: ctx.conversationId,
    title: ctx.conversation.title || "Work",
    readEvents: () => ctx.readEvents(),
  };
}

/** Shows the ledger's tasks as the chat's todo list. Written inside the tool call, so history never replays it. */
export async function appendTodoPlanEvent(
  ctx: CesiumToolContext,
  items: WorkLedgerItem[],
  raw: unknown
): Promise<void> {
  await ctx.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: ctx.conversationId,
      kind: "plan",
      planId: CESIUM_TODO_PLAN_ID,
      entries: ledgerPlanEntries(items),
      raw,
    },
  ]);
}

export function formatTodoList(items: WorkLedgerItem[]): string {
  const tasks = ledgerTasks(items);
  return tasks.length > 0
    ? tasks.map((item) => `- [${item.status}] ${item.key}: ${item.title}`).join("\n")
    : "No todos yet.";
}

/** Tasks in `next` with their ledger fields carried over from `current`, in `entries` order. */
function tasksFromEntries(entries: AgentPlanEntry[], current: WorkLedgerItem[]): WorkLedgerItem[] {
  const byKey = new Map(current.map((item) => [item.key, item]));
  return entries.map((entry) => {
    const existing = byKey.get(entry.id);
    return existing && existing.kind === "task"
      ? { ...existing, title: entry.content, status: entry.status }
      : newLedgerItem({ key: entry.id, kind: "task", title: entry.content, status: entry.status });
  });
}

export async function todoTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const action = asString(args.action) ?? "list";
  const items = Array.isArray(args.items) ? args.items : [];
  const scope = ledgerScope(ctx);
  if (action === "list") {
    return formatTodoList(await readWorkLedger(scope));
  }
  const parsedItems = parseTodoItems(items);
  let keptAssigned = 0;
  const saved = await writeWorkLedger(
    scope,
    (current) => {
      const tasks = ledgerTasks(current);
      const asEntries = ledgerPlanEntries(tasks);
      const entries =
        action === "patch"
          ? applyTodoPatch(asEntries, parsedItems)
          : todoEntriesFromReplace(parsedItems, asEntries);
      const listed = new Set(entries.map((entry) => entry.id));
      keptAssigned = action === "patch" ? 0 : tasks.filter((task) => task.assigned && !listed.has(task.key)).length;
      return [...ledgerMilestones(current), ...tasksFromEntries(entries, current)];
    },
    { deleteMissing: action !== "patch" }
  );
  await appendTodoPlanEvent(ctx, saved, args);
  const taskCount = ledgerTasks(saved).length;
  const summary =
    action === "patch"
      ? `Patched ${parsedItems.length} todo item${parsedItems.length === 1 ? "" : "s"}; the list now has ${taskCount}.`
      : `Stored ${taskCount} todo item${taskCount === 1 ? "" : "s"}.`;
  return [
    summary,
    keptAssigned > 0
      ? `Kept ${keptAssigned} item${keptAssigned === 1 ? "" : "s"} you left out because an agent is assigned to ${keptAssigned === 1 ? "it" : "them"}.`
      : null,
    formatTodoList(saved),
  ].filter(Boolean).join("\n");
}
