/** The status vocabulary todos, plan files and Goal milestones/todos share. */
export type WorkItemStatus = "pending" | "in_progress" | "blocked" | "completed";

const STATUS_ALIASES: Record<string, WorkItemStatus> = {
  pending: "pending",
  todo: "pending",
  open: "pending",
  not_started: "pending",
  backlog: "pending",
  in_progress: "in_progress",
  inprogress: "in_progress",
  running: "in_progress",
  active: "in_progress",
  doing: "in_progress",
  started: "in_progress",
  blocked: "blocked",
  stuck: "blocked",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
};

/** Undefined when no status was given; anything unrecognised is pending. */
export function normalizeWorkItemStatus(raw: unknown): WorkItemStatus | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return STATUS_ALIASES[key] ?? "pending";
}

/** Text comparison key: case, surrounding and repeated whitespace do not matter. */
export function workItemTextKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Stable ids for a list that replaces `previous`: an explicit id wins, then
 * the id of the previous item with the same text (so reordering or
 * rewriting a list keeps each item's identity, and whatever is joined to
 * it), then `fallback(index)` if unused, then the next unused `${prefix}-N`.
 */
export function assignWorkItemIds(
  items: Array<{ id?: string; text: string }>,
  previous: Array<{ id: string; text: string }>,
  prefix: string,
  fallback: (index: number) => string | undefined = (index) => `${prefix}-${index + 1}`
): string[] {
  const byText = new Map<string, string>();
  for (const item of previous) {
    const key = workItemTextKey(item.text);
    if (!byText.has(key)) byText.set(key, item.id);
  }
  const explicit = new Set(items.flatMap((item) => (item.id ? [item.id] : [])));
  // A previous id only carries over through its own text, never to a new item.
  const reserved = new Set(previous.map((item) => item.id));
  const used = new Set<string>();
  const free = (id: string | undefined): id is string =>
    Boolean(id) && !used.has(id!) && !explicit.has(id!) && !reserved.has(id!);
  let counter = 0;
  const nextFree = () => {
    let id: string;
    do {
      counter += 1;
      id = `${prefix}-${counter}`;
    } while (!free(id));
    return id;
  };
  return items.map((item, index) => {
    const matched = byText.get(workItemTextKey(item.text));
    const id =
      (item.id && !used.has(item.id) ? item.id : undefined) ??
      (matched && !used.has(matched) && !explicit.has(matched) ? matched : undefined) ??
      (free(fallback(index)) ? fallback(index)! : undefined) ??
      nextFree();
    used.add(id);
    return id;
  });
}

/** The lowest `${prefix}-N` not in `used`. */
export function nextWorkItemKey(used: ReadonlySet<string>, prefix: string): string {
  let counter = 1;
  while (used.has(`${prefix}-${counter}`)) {
    counter += 1;
  }
  return `${prefix}-${counter}`;
}
