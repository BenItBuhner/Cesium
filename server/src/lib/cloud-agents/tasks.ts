import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";
import type {
  CloudAgentTaskRecord,
  CloudAgentTaskStatus,
  CloudAgentTaskTimelineEntry,
} from "./types.js";

const TASKS_FILE = path.join(DATA_DIR, "cloud-agents", "tasks.json");
const MAX_TASKS = 500;
const MAX_TIMELINE = 200;

type TasksFile = {
  schemaVersion: 1;
  updatedAt: number;
  tasks: CloudAgentTaskRecord[];
};

let writeQueue: Promise<unknown> = Promise.resolve();

function withTaskLock<T>(run: () => Promise<T>): Promise<T> {
  const next = writeQueue.catch(() => undefined).then(run);
  writeQueue = next;
  return next;
}

function normalizeTask(raw: unknown): CloudAgentTaskRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as CloudAgentTaskRecord;
  if (record.schemaVersion !== 1 || typeof record.id !== "string" || !record.source) {
    return null;
  }
  return {
    ...record,
    timeline: Array.isArray(record.timeline) ? record.timeline.slice(-MAX_TIMELINE) : [],
  };
}

async function readTasksFile(): Promise<TasksFile> {
  const raw = await readJsonFile<unknown>(TASKS_FILE, null);
  if (!raw || typeof raw !== "object" || (raw as TasksFile).schemaVersion !== 1) {
    return { schemaVersion: 1, updatedAt: 0, tasks: [] };
  }
  const tasks = Array.isArray((raw as TasksFile).tasks)
    ? (raw as TasksFile).tasks
        .map(normalizeTask)
        .filter((task): task is CloudAgentTaskRecord => task != null)
    : [];
  return { schemaVersion: 1, updatedAt: (raw as TasksFile).updatedAt ?? 0, tasks };
}

async function saveTasksFile(tasks: CloudAgentTaskRecord[]): Promise<void> {
  await writeJsonFile(TASKS_FILE, {
    schemaVersion: 1,
    updatedAt: Date.now(),
    tasks: tasks.slice(0, MAX_TASKS),
  } satisfies TasksFile);
}

export function getCloudAgentTasksPath(): string {
  return TASKS_FILE;
}

export async function listCloudAgentTasks(options?: {
  workspaceId?: string;
  status?: CloudAgentTaskStatus;
}): Promise<CloudAgentTaskRecord[]> {
  const file = await readTasksFile();
  let tasks = file.tasks;
  if (options?.workspaceId) {
    tasks = tasks.filter((task) => task.workspaceId === options.workspaceId);
  }
  if (options?.status) {
    tasks = tasks.filter((task) => task.status === options.status);
  }
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCloudAgentTask(id: string): Promise<CloudAgentTaskRecord | null> {
  const file = await readTasksFile();
  return file.tasks.find((task) => task.id === id) ?? null;
}

export async function createCloudAgentTask(
  input: Omit<
    CloudAgentTaskRecord,
    "schemaVersion" | "id" | "createdAt" | "updatedAt" | "timeline"
  > & { timeline?: CloudAgentTaskTimelineEntry[] }
): Promise<CloudAgentTaskRecord> {
  return withTaskLock(async () => {
    const now = Date.now();
    const task: CloudAgentTaskRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      timeline: input.timeline ?? [],
      ...input,
    };
    const file = await readTasksFile();
    await saveTasksFile([task, ...file.tasks]);
    return task;
  });
}

export async function updateCloudAgentTask(
  id: string,
  patch: Partial<Omit<CloudAgentTaskRecord, "schemaVersion" | "id" | "createdAt">>
): Promise<CloudAgentTaskRecord> {
  return withTaskLock(async () => {
    const file = await readTasksFile();
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index === -1) {
      throw new Error(`Unknown Cloud Agent task: ${id}`);
    }
    const next: CloudAgentTaskRecord = {
      ...file.tasks[index]!,
      ...patch,
      updatedAt: Date.now(),
    };
    const tasks = [...file.tasks];
    tasks[index] = next;
    await saveTasksFile(tasks);
    return next;
  });
}

export async function appendCloudAgentTaskTimeline(
  id: string,
  entry: Omit<CloudAgentTaskTimelineEntry, "at"> & { at?: number }
): Promise<CloudAgentTaskRecord> {
  return withTaskLock(async () => {
    const file = await readTasksFile();
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index === -1) {
      throw new Error(`Unknown Cloud Agent task: ${id}`);
    }
    const current = file.tasks[index]!;
    const next: CloudAgentTaskRecord = {
      ...current,
      updatedAt: Date.now(),
      timeline: [
        ...current.timeline,
        { at: entry.at ?? Date.now(), kind: entry.kind, message: entry.message },
      ].slice(-MAX_TIMELINE),
    };
    const tasks = [...file.tasks];
    tasks[index] = next;
    await saveTasksFile(tasks);
    return next;
  });
}

export async function deleteCloudAgentTask(id: string): Promise<void> {
  await withTaskLock(async () => {
    const file = await readTasksFile();
    await saveTasksFile(file.tasks.filter((task) => task.id !== id));
  });
}

/** Finds the task currently bound to a conversation (for status mirroring). */
export async function findCloudAgentTaskByConversation(
  conversationId: string
): Promise<CloudAgentTaskRecord | null> {
  const file = await readTasksFile();
  return file.tasks.find((task) => task.conversationId === conversationId) ?? null;
}

/**
 * Finds an active task tracking the same external source (same issue/thread),
 * so follow-up comments steer the existing conversation instead of spawning a
 * duplicate task. Completed/cancelled tasks are not steerable.
 */
export async function findSteerableCloudAgentTaskBySource(source: {
  providerId: string;
  externalId?: string;
  repo?: string;
  channel?: string;
}): Promise<CloudAgentTaskRecord | null> {
  if (!source.externalId) {
    return null;
  }
  const file = await readTasksFile();
  return (
    file.tasks.find((task) => {
      if (
        task.source.providerId !== source.providerId ||
        task.source.externalId !== source.externalId ||
        !task.conversationId ||
        task.status === "completed" ||
        task.status === "cancelled"
      ) {
        return false;
      }
      if (source.providerId === "github") {
        return task.source.repo === source.repo;
      }
      if (source.providerId === "slack") {
        return task.source.channel === source.channel;
      }
      return true;
    }) ?? null
  );
}
