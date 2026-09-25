import type { AgentPlanEntry, AgentStoredEvent } from "../types.js";
import { asRecord, asString } from "./cesium-coerce.js";

export const CESIUM_TODO_PLAN_ID = "cesium-todos";

export type TodoStatus = AgentPlanEntry["status"];

/**
 * One `todo` tool item after coercion. `status` stays undefined when the model
 * omitted it so a patch can leave the existing status alone; `replace`
 * defaults it to pending. `content` is undefined for id-only patch items such
 * as `{ id: "todo-2", status: "completed" }`.
 */
export type ParsedTodoItem = {
  id?: string;
  title?: string;
  content?: string;
  status?: TodoStatus;
  /** Position in the raw items array; replace-mode fallback ids are 1-based from it. */
  sourceIndex: number;
};

export function normalizeTodoStatus(raw: string | undefined): TodoStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }
  if (normalized === "blocked" || normalized === "stuck") {
    return "blocked";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "in progress" ||
    normalized === "running"
  ) {
    return "in_progress";
  }
  return "pending";
}

export function parseTodoItems(items: unknown[]): ParsedTodoItem[] {
  return items.flatMap((item, sourceIndex): ParsedTodoItem[] => {
    const record = asRecord(item);
    const id = asString(record?.id);
    const title = asString(record?.title);
    const content =
      asString(record?.content) ??
      title ??
      asString(record?.text) ??
      asString(record?.description) ??
      asString(item);
    if (!content && !id) {
      return [];
    }
    return [
      {
        id,
        title,
        content,
        status: normalizeTodoStatus(asString(record?.status)),
        sourceIndex,
      },
    ];
  });
}

/**
 * `replace` semantics: the incoming items become the whole list. Items with
 * no content have nothing to display and are skipped, as before.
 */
export function todoEntriesFromReplace(items: ParsedTodoItem[]): AgentPlanEntry[] {
  return items.flatMap((item): AgentPlanEntry[] =>
    item.content
      ? [
          {
            id: item.id ?? item.title ?? `todo-${item.sourceIndex + 1}`,
            content: item.content,
            status: item.status ?? "pending",
          },
        ]
      : []
  );
}

function contentKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `patch` semantics: merge the incoming items into the existing list. An item
 * matches an existing entry by explicit id, by title (titles double as ids in
 * replace mode), or by content; matched entries take the incoming content and,
 * when provided, status. Unmatched items are appended with a fresh id.
 * Entries the patch does not mention are kept as they are.
 */
export function applyTodoPatch(
  existing: AgentPlanEntry[],
  items: ParsedTodoItem[]
): AgentPlanEntry[] {
  const next = existing.map((entry) => ({ ...entry }));
  let counter = next.length;
  for (const item of items) {
    const match =
      (item.id ? next.find((entry) => entry.id === item.id) : undefined) ??
      (item.title ? next.find((entry) => entry.id === item.title) : undefined) ??
      (item.content
        ? next.find((entry) => contentKey(entry.content) === contentKey(item.content!))
        : undefined);
    if (match) {
      if (item.content) {
        match.content = item.content;
      }
      if (item.status) {
        match.status = item.status;
      }
      continue;
    }
    if (!item.content) {
      // An id-only item that matches nothing has no text to add.
      continue;
    }
    let id = item.id ?? item.title;
    while (!id || next.some((entry) => entry.id === id)) {
      counter += 1;
      id = `todo-${counter}`;
    }
    next.push({ id, content: item.content, status: item.status ?? "pending" });
  }
  return next;
}

/** Entries of the newest `plan` event, i.e. the current todo list. */
export function latestTodoEntries(events: AgentStoredEvent[]): AgentPlanEntry[] | null {
  const latest = [...events].reverse().find((event) => event.kind === "plan");
  return latest?.kind === "plan" ? latest.entries : null;
}
