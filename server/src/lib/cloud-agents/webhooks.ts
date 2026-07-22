import { createHmac, timingSafeEqual } from "node:crypto";
import { extractMarkdownMediaRefs, normalizeSlackMrkdwn } from "./attachments.js";
import type {
  CloudAgentInboundAssignment,
  CloudAgentMediaRef,
  CloudAgentProviderId,
} from "./types.js";

export type CloudAgentWebhookResult =
  | { kind: "assignment"; assignment: CloudAgentInboundAssignment }
  | { kind: "challenge"; challenge: string }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string };

const SLACK_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqualHex(signatureHeader, expected);
}

export function verifyLinearSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(signatureHeader, expected);
}

export function verifySlackSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  nowMs = Date.now()
): boolean {
  if (!signatureHeader?.startsWith("v0=") || !timestampHeader) {
    return false;
  }
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - timestamp) > SLACK_TIMESTAMP_TOLERANCE_SEC) {
    return false;
  }
  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestampHeader}:${rawBody}`)
    .digest("hex")}`;
  return safeEqualHex(signatureHeader, expected);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseGithubPayload(
  eventName: string | undefined,
  payload: unknown,
  verified: boolean
): CloudAgentWebhookResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: "ignored", reason: "Empty GitHub payload." };
  }
  const action = typeof record.action === "string" ? record.action : "";
  const repoRecord = asRecord(record.repository);
  const repo = typeof repoRecord?.full_name === "string" ? repoRecord.full_name : undefined;
  const senderRecord = asRecord(record.sender);
  const sender =
    typeof senderRecord?.login === "string" ? `@${senderRecord.login}` : undefined;

  if (eventName === "issues" && (action === "assigned" || action === "opened" || action === "labeled")) {
    const issue = asRecord(record.issue);
    if (!issue) {
      return { kind: "ignored", reason: "GitHub issues payload missing issue." };
    }
    if (action !== "assigned") {
      // Only explicit assignment offloads work; opened/labeled are informational.
      return { kind: "ignored", reason: `GitHub issues action "${action}" is not an assignment.` };
    }
    const number = issue.number;
    const labels = Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => asRecord(label)?.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    const body = typeof issue.body === "string" ? issue.body : "";
    const mediaRefs = extractMarkdownMediaRefs(body);
    return {
      kind: "assignment",
      assignment: {
        providerId: "github",
        title:
          typeof issue.title === "string" && issue.title.trim()
            ? issue.title.trim()
            : `GitHub issue${typeof number === "number" ? ` #${number}` : ""}`,
        body,
        source: {
          providerId: "github",
          ...(typeof number === "number" ? { externalId: String(number) } : {}),
          ...(typeof issue.html_url === "string" ? { url: issue.html_url } : {}),
          ...(repo ? { repo } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(sender ? { sender } : {}),
        },
        verified,
        ...(mediaRefs.length > 0 ? { mediaRefs } : {}),
      },
    };
  }

  if (eventName === "issue_comment" && action === "created") {
    const issue = asRecord(record.issue);
    const comment = asRecord(record.comment);
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!issue || !body.trim()) {
      return { kind: "ignored", reason: "GitHub comment payload missing content." };
    }
    const number = issue.number;
    const commentMediaRefs = extractMarkdownMediaRefs(body);
    return {
      kind: "assignment",
      assignment: {
        providerId: "github",
        title: `Comment on ${repo ?? "repo"}#${typeof number === "number" ? number : "?"}: ${
          typeof issue.title === "string" ? issue.title : ""
        }`.trim(),
        body,
        source: {
          providerId: "github",
          ...(typeof number === "number" ? { externalId: String(number) } : {}),
          ...(typeof comment?.html_url === "string" ? { url: comment.html_url } : {}),
          ...(repo ? { repo } : {}),
          ...(sender ? { sender } : {}),
        },
        verified,
        ...(commentMediaRefs.length > 0 ? { mediaRefs: commentMediaRefs } : {}),
      },
    };
  }

  return { kind: "ignored", reason: `Unhandled GitHub event "${eventName ?? "unknown"}".` };
}

function parseLinearPayload(payload: unknown, verified: boolean): CloudAgentWebhookResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: "ignored", reason: "Empty Linear payload." };
  }
  const type = typeof record.type === "string" ? record.type : "";
  const action = typeof record.action === "string" ? record.action : "";
  const data = asRecord(record.data);
  if (!data) {
    return { kind: "ignored", reason: "Linear payload missing data." };
  }

  if (type === "Issue" && (action === "create" || action === "update")) {
    const assignee = asRecord(data.assignee);
    if (!assignee) {
      return { kind: "ignored", reason: "Linear issue has no assignee." };
    }
    if (action === "update") {
      const updatedFrom = asRecord(record.updatedFrom);
      const assigneeChanged = updatedFrom ? "assigneeId" in updatedFrom : false;
      if (!assigneeChanged) {
        return { kind: "ignored", reason: "Linear issue update did not change the assignee." };
      }
    }
    const team = asRecord(data.team);
    const project = asRecord(data.project);
    const labels = Array.isArray(data.labels)
      ? data.labels
          .map((label) => asRecord(label)?.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    const identifier = typeof data.identifier === "string" ? data.identifier : undefined;
    const description = typeof data.description === "string" ? data.description : "";
    const issueMediaRefs = extractMarkdownMediaRefs(description);
    return {
      kind: "assignment",
      assignment: {
        providerId: "linear",
        title:
          typeof data.title === "string" && data.title.trim()
            ? `${identifier ? `${identifier}: ` : ""}${data.title.trim()}`
            : identifier ?? "Linear issue",
        body: description,
        source: {
          providerId: "linear",
          ...(typeof data.id === "string" ? { externalId: data.id } : {}),
          ...(typeof record.url === "string"
            ? { url: record.url }
            : typeof data.url === "string"
              ? { url: data.url }
              : {}),
          ...(typeof team?.key === "string" ? { teamKey: team.key } : {}),
          ...(typeof project?.name === "string" ? { project: project.name } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(typeof assignee.name === "string" ? { sender: assignee.name } : {}),
        },
        verified,
        ...(issueMediaRefs.length > 0 ? { mediaRefs: issueMediaRefs } : {}),
      },
    };
  }

  // Comments on a tracked issue steer the running conversation. Comments on
  // untracked issues are ignored (followUpOnly) instead of creating tasks.
  if (type === "Comment" && action === "create") {
    const issue = asRecord(data.issue);
    const body = typeof data.body === "string" ? data.body : "";
    const issueId = typeof issue?.id === "string" ? issue.id : undefined;
    if (!issueId || !body.trim()) {
      return { kind: "ignored", reason: "Linear comment payload missing issue or body." };
    }
    const user = asRecord(data.user);
    const commentMediaRefs = extractMarkdownMediaRefs(body);
    return {
      kind: "assignment",
      assignment: {
        providerId: "linear",
        title: `Comment on ${typeof issue?.identifier === "string" ? issue.identifier : "Linear issue"}`,
        body,
        source: {
          providerId: "linear",
          externalId: issueId,
          ...(typeof record.url === "string" ? { url: record.url } : {}),
          ...(typeof user?.name === "string" ? { sender: user.name } : {}),
        },
        verified,
        followUpOnly: true,
        ...(commentMediaRefs.length > 0 ? { mediaRefs: commentMediaRefs } : {}),
      },
    };
  }

  return { kind: "ignored", reason: `Unhandled Linear event "${type}/${action}".` };
}

function parseSlackPayload(payload: unknown, verified: boolean): CloudAgentWebhookResult {
  const record = asRecord(payload);
  if (!record) {
    return { kind: "ignored", reason: "Empty Slack payload." };
  }
  if (record.type === "url_verification" && typeof record.challenge === "string") {
    return { kind: "challenge", challenge: record.challenge };
  }
  if (record.type !== "event_callback") {
    return { kind: "ignored", reason: `Unhandled Slack payload type "${String(record.type)}".` };
  }
  const event = asRecord(record.event);
  if (!event || (event.type !== "app_mention" && event.type !== "message")) {
    return { kind: "ignored", reason: "Unhandled Slack event type." };
  }
  if (event.type === "message" && (event.subtype || event.bot_id)) {
    return { kind: "ignored", reason: "Slack bot/system messages are ignored." };
  }
  const text = typeof event.text === "string" ? event.text : "";
  const files = Array.isArray(event.files) ? event.files : [];
  const mediaRefs: CloudAgentMediaRef[] = files.flatMap((file): CloudAgentMediaRef[] => {
    const record = asRecord(file);
    const url =
      typeof record?.url_private_download === "string"
        ? record.url_private_download
        : typeof record?.url_private === "string"
          ? record.url_private
          : undefined;
    if (!url) {
      return [];
    }
    return [
      {
        url,
        ...(typeof record?.name === "string" ? { name: record.name } : {}),
        ...(typeof record?.mimetype === "string" ? { mimeType: record.mimetype } : {}),
      },
    ];
  });
  if (!text.trim() && mediaRefs.length === 0) {
    return { kind: "ignored", reason: "Slack event has no text or files." };
  }
  // Strip the leading bot mention, then convert mrkdwn to standard markdown
  // so the agent prompt reads naturally.
  const cleaned = normalizeSlackMrkdwn(text.replace(/^\s*<@[^>]+>\s*/, "").trim());
  const channel = typeof event.channel === "string" ? event.channel : undefined;
  const ts =
    typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : undefined;
  // Replies inside a tracked thread steer the running conversation; fresh
  // mentions start new tasks. thread_ts is only present on replies.
  const isThreadReply = typeof event.thread_ts === "string";
  return {
    kind: "assignment",
    assignment: {
      providerId: "slack",
      title: `Slack: ${cleaned.slice(0, 80)}${cleaned.length > 80 ? "…" : ""}`,
      body: cleaned || "(Attached media only.)",
      source: {
        providerId: "slack",
        ...(ts ? { externalId: ts } : {}),
        ...(channel ? { channel } : {}),
        ...(typeof event.user === "string" ? { sender: `<@${event.user}>` } : {}),
      },
      verified,
      ...(isThreadReply && event.type === "message" ? { followUpOnly: true } : {}),
      ...(mediaRefs.length > 0 ? { mediaRefs } : {}),
    },
  };
}

/**
 * Verifies + parses a raw provider webhook. When a webhook secret is stored,
 * bad signatures are rejected outright; without one the payload is accepted
 * but the resulting task is flagged unverified.
 */
export function processCloudAgentWebhook(input: {
  providerId: CloudAgentProviderId;
  rawBody: string;
  headers: Record<string, string | undefined>;
  webhookSecret: string | null;
  nowMs?: number;
}): CloudAgentWebhookResult {
  let payload: unknown = null;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { kind: "rejected", reason: "Webhook body is not valid JSON." };
  }

  let verified = false;
  if (input.webhookSecret) {
    switch (input.providerId) {
      case "github":
        verified = verifyGithubSignature(
          input.rawBody,
          input.headers["x-hub-signature-256"],
          input.webhookSecret
        );
        break;
      case "linear":
        verified = verifyLinearSignature(
          input.rawBody,
          input.headers["linear-signature"],
          input.webhookSecret
        );
        break;
      case "slack":
        verified = verifySlackSignature(
          input.rawBody,
          input.headers["x-slack-signature"],
          input.headers["x-slack-request-timestamp"],
          input.webhookSecret,
          input.nowMs
        );
        break;
    }
    if (!verified) {
      return { kind: "rejected", reason: "Webhook signature verification failed." };
    }
  }

  switch (input.providerId) {
    case "github":
      return parseGithubPayload(input.headers["x-github-event"], payload, verified);
    case "linear":
      return parseLinearPayload(payload, verified);
    case "slack":
      return parseSlackPayload(payload, verified);
  }
}
