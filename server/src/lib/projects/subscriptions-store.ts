import { randomBytes } from "node:crypto";
import path from "node:path";
import type {
  ProjectPullRequest,
  ProjectSubscriptionKind,
  ProjectSubscriptionSummary,
} from "@cesium/core/projects";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { getProjectDir } from "./paths.js";
import type { ProjectChildRecord } from "./types.js";

export type GithubPrSpec = { kind: "github_pr"; repo: string; number: number; keepAfterClose: boolean };
export type GithubCiSpec = { kind: "github_ci"; repo: string; branch: string; oneShot: boolean };
export type TimerSpec = {
  kind: "timer";
  name: string;
  prompt: string;
  cron: string | null;
  intervalSeconds: number | null;
  once: boolean;
};
export type ProjectSubscriptionSpec = GithubPrSpec | GithubCiSpec | TimerSpec;

/** Cursors that let a poll tell new activity from what was already seen. */
export type ProjectSubscriptionState = {
  /** False until the first poll records a baseline; only later activity is delivered. */
  primed?: boolean;
  prState?: "open" | "closed" | "merged";
  draft?: boolean;
  headSha?: string | null;
  /** Head whose conflict with the base was reported; cleared once the PR merges cleanly again. */
  conflictSha?: string | null;
  seenCommentIds?: number[];
  seenReviewIds?: number[];
  seenReviewCommentIds?: number[];
  ciSha?: string | null;
  ciDeliveredConclusion?: "success" | "failure" | null;
  ciDeliveredSha?: string | null;
  nextFireAt?: number | null;
  fired?: number;
  /** Latest snapshot of a PR no agent owns (followed on request), for PR lists. */
  pr?: ProjectPullRequest;
};

export type ProjectSubscriptionRecord = {
  id: string;
  kind: ProjectSubscriptionKind;
  spec: ProjectSubscriptionSpec;
  createdBy: ProjectSubscriptionSummary["createdBy"];
  /** Agent whose PR or branch this watches (auto subscriptions). */
  childId: string | null;
  createdAt: number;
  expiresAt: number;
  lastPolledAt: number | null;
  lastEventAt: number | null;
  closedAt: number | null;
  closedReason: string | null;
  state: ProjectSubscriptionState;
};

type SubscriptionsFile = { schemaVersion: 1; subscriptions: ProjectSubscriptionRecord[] };

const CLOSED_KEPT = 100;
const queues = new Map<string, Promise<unknown>>();

function subscriptionsPath(projectId: string): string {
  return path.join(getProjectDir(projectId), "subscriptions.json");
}

export function newSubscriptionId(): string {
  return `sub_${randomBytes(6).toString("hex")}`;
}

export async function readProjectSubscriptions(projectId: string): Promise<ProjectSubscriptionRecord[]> {
  const file = await readJsonFile<SubscriptionsFile | null>(subscriptionsPath(projectId), null);
  return Array.isArray(file?.subscriptions) ? file.subscriptions : [];
}

/** Read-modify-write under a per-Project lock; return the same array to skip the write. */
export async function mutateProjectSubscriptions(
  projectId: string,
  mutate: (
    current: ProjectSubscriptionRecord[]
  ) => ProjectSubscriptionRecord[] | Promise<ProjectSubscriptionRecord[]>
): Promise<ProjectSubscriptionRecord[]> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readProjectSubscriptions(projectId);
      const mutated = await mutate(current);
      if (mutated === current) {
        return current;
      }
      const open = mutated.filter((entry) => entry.closedAt == null);
      const closed = mutated
        .filter((entry) => entry.closedAt != null)
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
        .slice(0, CLOSED_KEPT);
      const kept = [...open, ...closed];
      await writeJsonFile(subscriptionsPath(projectId), {
        schemaVersion: 1,
        subscriptions: kept,
      } satisfies SubscriptionsFile);
      return kept;
    });
  queues.set(projectId, next);
  try {
    return await next;
  } finally {
    if (queues.get(projectId) === next) {
      queues.delete(projectId);
    }
  }
}

function everyLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "every day" : `every ${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
  }
  return `every ${seconds}s`;
}

/** How the Listening list names a subscription. */
export function subscriptionLabel(spec: ProjectSubscriptionSpec): string {
  switch (spec.kind) {
    case "github_pr":
      return `${spec.repo}#${spec.number}`;
    case "github_ci":
      return `CI on ${spec.branch}`;
    case "timer":
      return spec.cron
        ? `${spec.name} · cron ${spec.cron}`
        : spec.once
          ? `${spec.name} · once`
          : `${spec.name} · ${everyLabel(spec.intervalSeconds ?? 60)}`;
  }
}

export function summarizeSubscription(
  record: ProjectSubscriptionRecord,
  children: readonly Pick<ProjectChildRecord, "id" | "name">[]
): ProjectSubscriptionSummary {
  const spec = record.spec;
  return {
    id: record.id,
    kind: record.kind,
    label: subscriptionLabel(spec),
    detail:
      spec.kind === "timer"
        ? spec.prompt.length > 160
          ? `${spec.prompt.slice(0, 159)}…`
          : spec.prompt
        : spec.kind === "github_ci"
          ? spec.repo
          : null,
    createdBy: record.createdBy,
    agent: record.childId ? (children.find((child) => child.id === record.childId)?.name ?? null) : null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    nextFireAt: spec.kind === "timer" ? (record.state.nextFireAt ?? null) : null,
    lastEventAt: record.lastEventAt,
    closedAt: record.closedAt,
    closedReason: record.closedReason,
  };
}
