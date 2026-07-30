/**
 * Cross-conversation context tools for the Cesium harness.
 *
 * Conversations are queryable context: the composer lets the user tag a chat
 * (which expands into a `<conversation-reference>` block), and these helpers
 * back the `list_conversations` / `read_conversation` / `search_conversations`
 * tools so the agent can triage transcripts from any workspace — not only the
 * ones the user explicitly tagged.
 */
import { getStorage } from "../../../storage/runtime.js";
import { listWorkspaces } from "../../workspace-registry.js";
import type { WorkspaceRecord } from "../../workspace-registry.js";
import { generateTranscriptFromEvents } from "../event-log-read.js";
import type { AgentConversationRecord, AgentStoredEvent } from "../types.js";

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
/** Transcript payload cap so a giant chat cannot blow the parent context. */
const READ_DEFAULT_MAX_CHARS = 24_000;
const READ_MAX_CHARS = 120_000;
const READ_DEFAULT_TURNS = 40;
/** Global search stays bounded: newest conversations first, recent events only. */
const SEARCH_MAX_CONVERSATIONS = 40;
const SEARCH_EVENTS_PER_CONVERSATION = 600;
const SEARCH_DEFAULT_RESULTS = 12;
const SEARCH_MAX_RESULTS = 50;
const SEARCH_SNIPPET_CHARS = 240;

async function workspacesById(): Promise<Map<string, WorkspaceRecord>> {
  const workspaces = await listWorkspaces().catch(() => [] as WorkspaceRecord[]);
  return new Map(workspaces.map((workspace) => [workspace.id, workspace]));
}

function describeConversation(
  conversation: AgentConversationRecord,
  workspaces: Map<string, WorkspaceRecord>,
  currentConversationId?: string
): string {
  const workspace = workspaces.get(conversation.workspaceId);
  const where = workspace
    ? `${workspace.name} (${workspace.root})`
    : `workspace ${conversation.workspaceId}`;
  const marker = conversation.id === currentConversationId ? " [this conversation]" : "";
  return (
    `- ${conversation.id}${marker} | "${conversation.title}" | ${where} | ` +
    `${conversation.config.backendId} | updated ${new Date(conversation.updatedAt).toISOString()}`
  );
}

export async function listConversationsForAgent(input: {
  query?: string;
  workspaceId?: string;
  limit?: number;
  currentConversationId?: string;
}): Promise<string> {
  const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(input.limit ?? LIST_DEFAULT_LIMIT)));
  const query = input.query?.trim().toLowerCase();
  const storage = await getStorage();
  const workspaces = await workspacesById();

  const matches: AgentConversationRecord[] = [];
  let cursor: string | null | undefined = null;
  // Newest-first scan across all workspaces; stop once the page fills.
  do {
    const page = await storage.listAgentConversations({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      cursor,
      limit: 200,
      includeArchived: true,
    });
    for (const record of page.records) {
      if (query) {
        const workspace = workspaces.get(record.workspaceId);
        const haystack = `${record.title} ${record.id} ${workspace?.name ?? ""} ${workspace?.root ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
      }
      matches.push(record);
      if (matches.length >= limit) {
        break;
      }
    }
    cursor = page.nextCursor;
  } while (cursor && matches.length < limit);

  if (matches.length === 0) {
    return query
      ? `No conversations matched "${input.query}".`
      : "No saved conversations found.";
  }
  return [
    `${matches.length} conversation(s), newest first. Use read_conversation with an id for the transcript.`,
    ...matches.map((record) =>
      describeConversation(record, workspaces, input.currentConversationId)
    ),
  ].join("\n");
}

export async function readConversationTranscriptForAgent(input: {
  conversationId: string;
  limitTurns?: number;
  maxChars?: number;
}): Promise<string> {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    throw new Error("read_conversation.conversationId is required.");
  }
  const storage = await getStorage();
  const record = await storage.getAgentConversation(conversationId);
  if (!record) {
    throw new Error(
      `Unknown conversation: ${conversationId}. Use list_conversations to find valid ids.`
    );
  }
  const limitTurns = Math.max(1, Math.min(250, Math.floor(input.limitTurns ?? READ_DEFAULT_TURNS)));
  const maxChars = Math.max(
    1_000,
    Math.min(READ_MAX_CHARS, Math.floor(input.maxChars ?? READ_DEFAULT_MAX_CHARS))
  );
  const events = await storage.readRecentAgentEvents(conversationId, limitTurns * 50 + 100);
  const transcript = generateTranscriptFromEvents(events).trim();
  const workspaces = await workspacesById();
  const workspace = workspaces.get(record.workspaceId);
  const header =
    `Conversation ${record.id} — "${record.title}" — ` +
    `${workspace ? `${workspace.name} (${workspace.root})` : `workspace ${record.workspaceId}`} — ` +
    `updated ${new Date(record.updatedAt).toISOString()}`;
  if (!transcript) {
    return `${header}\n(Transcript is empty.)`;
  }
  const truncated = transcript.length > maxChars;
  const body = truncated ? transcript.slice(transcript.length - maxChars) : transcript;
  return [
    header,
    truncated
      ? `(Transcript truncated to the most recent ${maxChars} characters; raise maxChars or lower limitTurns to page differently.)`
      : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eventSearchText(event: AgentStoredEvent): string {
  switch (event.kind) {
    case "user_message":
      return event.content;
    case "assistant_message_chunk":
    case "reasoning":
      return event.text;
    case "tool_call":
    case "tool_call_update":
      return `${event.title} ${event.detail ?? ""}`;
    case "system":
      return event.text;
    default:
      return "";
  }
}

export async function searchConversationsForAgent(input: {
  query: string;
  conversationId?: string;
  maxResults?: number;
}): Promise<string> {
  const query = input.query?.trim();
  if (!query) {
    throw new Error("search_conversations.query is required.");
  }
  const maxResults = Math.max(
    1,
    Math.min(SEARCH_MAX_RESULTS, Math.floor(input.maxResults ?? SEARCH_DEFAULT_RESULTS))
  );
  const regex = new RegExp(escapeRegex(query), "i");
  const storage = await getStorage();
  const workspaces = await workspacesById();

  let candidates: AgentConversationRecord[];
  if (input.conversationId?.trim()) {
    const record = await storage.getAgentConversation(input.conversationId.trim());
    if (!record) {
      throw new Error(`Unknown conversation: ${input.conversationId}.`);
    }
    candidates = [record];
  } else {
    const page = await storage.listAgentConversations({
      limit: SEARCH_MAX_CONVERSATIONS,
      includeArchived: true,
    });
    candidates = page.records;
  }

  const hits: string[] = [];
  for (const record of candidates) {
    if (hits.length >= maxResults) {
      break;
    }
    const events = await storage
      .readRecentAgentEvents(record.id, SEARCH_EVENTS_PER_CONVERSATION)
      .catch(() => [] as AgentStoredEvent[]);
    for (const event of events) {
      if (hits.length >= maxResults) {
        break;
      }
      const text = eventSearchText(event);
      const match = text ? regex.exec(text) : null;
      if (!match) {
        continue;
      }
      const start = Math.max(0, match.index - Math.floor(SEARCH_SNIPPET_CHARS / 3));
      const snippet = text
        .slice(start, start + SEARCH_SNIPPET_CHARS)
        .replace(/\s+/g, " ")
        .trim();
      const workspace = workspaces.get(record.workspaceId);
      hits.push(
        `- ${record.id} ("${record.title}"${workspace ? `, ${workspace.name}` : ""}) seq ${event.seq} [${event.kind}]: …${snippet}…`
      );
    }
  }

  if (hits.length === 0) {
    const scope = input.conversationId
      ? `conversation ${input.conversationId}`
      : `the ${candidates.length} most recent conversations`;
    return `No matches for "${query}" in ${scope}. Try list_conversations or a different query.`;
  }
  return [
    `${hits.length} match(es) for "${query}". Use read_conversation with an id for full context.`,
    ...hits,
  ].join("\n");
}
